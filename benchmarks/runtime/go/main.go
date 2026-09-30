package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type failure int

func (f failure) Error() string { return strconv.Itoa(int(f)) }

type subscription struct {
	messages chan []byte
	stop     chan struct{}
	once     sync.Once
}

func (s *subscription) close() { s.once.Do(func() { close(s.stop) }) }

type service struct {
	pool    *pgxpool.Pool
	sql     map[string]string
	key     string
	slots   chan struct{}
	queued  atomic.Int64
	open    atomic.Int64
	dropped atomic.Int64
	errors  atomic.Int64
	mu      sync.Mutex
	streams map[string]map[*subscription]bool
}
type database struct {
	server    *service
	conn      *pgxpool.Conn
	ctx       context.Context
	wait, sql time.Duration
}

func (d *database) query(name string, args ...any) ([][]any, error) {
	if d.conn == nil {
		start := time.Now()
		conn, err := d.server.pool.Acquire(d.ctx)
		d.wait += time.Since(start)
		if err != nil {
			return nil, err
		}
		d.conn = conn
	}
	start := time.Now()
	defer func() { d.sql += time.Since(start) }()
	rows, err := d.conn.Query(d.ctx, d.server.sql[name], args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := [][]any{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		result = append(result, values)
	}
	return result, rows.Err()
}
func (d *database) release() {
	if d.conn != nil {
		d.conn.Release()
		d.conn = nil
	}
}

var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var roomPattern = regexp.MustCompile(`^[a-z2-9]{12}$`)
var roomRoute = regexp.MustCompile(`^/rooms/([a-z2-9]{12})/(tasks|roster|events)$`)
var filePath = regexp.MustCompile(`^[a-zA-Z0-9_./-]{1,200}$`)
var fileSHA = regexp.MustCompile(`^[a-f0-9]{16}$`)

func text(m map[string]json.RawMessage, key string) string {
	var value string
	_ = json.Unmarshal(m[key], &value)
	return value
}
func integer(m map[string]json.RawMessage, key string, min, max int64) (int64, error) {
	var n int64
	if string(m[key]) == "null" || json.Unmarshal(m[key], &n) != nil || n < min || n > max {
		return 0, failure(400)
	}
	return n, nil
}
func body(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2*1024*1024))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, failure(413)
		}
		return nil, failure(400)
	}
	var extra any
	if value == nil || decoder.Decode(&extra) != io.EOF {
		return nil, failure(400)
	}
	return value, nil
}
func files(raw json.RawMessage) ([]FileEntry, error) {
	var wire []struct {
		Path string `json:"path"`
		SHA  string `json:"sha"`
		Size *int64 `json:"size"`
	}
	if json.Unmarshal(raw, &wire) != nil || wire == nil || len(wire) > 20000 {
		return nil, failure(400)
	}
	list := make([]FileEntry, len(wire))
	seen := make(map[string]bool, len(wire))
	for index, file := range wire {
		if !filePath.MatchString(file.Path) || !fileSHA.MatchString(file.SHA) || seen[file.Path] || file.Size == nil || *file.Size < 0 || *file.Size > 1000000000 {
			return nil, failure(400)
		}
		seen[file.Path] = true
		list[index] = FileEntry{file.Path, file.SHA, *file.Size}
	}
	return list, nil
}
func (s *service) compute(ctx context.Context, work func() map[string]any) (map[string]any, error) {
	if s.queued.Add(1) > int64(cap(s.slots)+256) {
		s.queued.Add(-1)
		return nil, failure(503)
	}
	defer s.queued.Add(-1)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
		return work(), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (s *service) handler(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	d := &database{server: s, ctx: ctx}
	defer d.release()
	send := func(status int, value any, raw bool) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Server-Timing", fmt.Sprintf("pool;dur=%.3f,db;dur=%.3f,total;dur=%.3f", float64(d.wait.Microseconds())/1000, float64(d.sql.Microseconds())/1000, float64(time.Since(started).Microseconds())/1000))
		w.WriteHeader(status)
		if raw {
			_, _ = io.WriteString(w, value.(string))
		} else {
			_ = json.NewEncoder(w).Encode(value)
		}
	}
	err := func() error {
		if r.Header.Get("X-Benchmark-Key") != s.key {
			return failure(401)
		}
		path := r.URL.Path
		method := r.Method
		if method == "GET" && path == "/health" {
			send(200, map[string]any{"ok": true}, false)
			return nil
		}
		if method == "GET" && path == "/stats" {
			var usage syscall.Rusage
			_ = syscall.Getrusage(syscall.RUSAGE_SELF, &usage)
			send(200, map[string]any{"cpuUserMicros": usage.Utime.Sec*1000000 + int64(usage.Utime.Usec), "cpuSystemMicros": usage.Stime.Sec*1000000 + int64(usage.Stime.Usec), "openStreams": s.open.Load(), "dropped": s.dropped.Load(), "errors": s.errors.Load(), "queued": max(int64(0), s.queued.Load()-int64(len(s.slots)))}, false)
			return nil
		}
		if method == "POST" && (path == "/graph" || path == "/snapshot") {
			input, err := body(w, r)
			if err != nil {
				return err
			}
			var work func() map[string]any
			if path == "/graph" {
				n, err := integer(input, "nodes", 16, 25000)
				if err != nil {
					return err
				}
				rounds, err := integer(input, "rounds", 1, 64)
				if err != nil {
					return err
				}
				seed, err := integer(input, "seed", 0, 1000000)
				if err != nil {
					return err
				}
				work = func() map[string]any { return graph(uint32(n), uint32(rounds), uint32(seed)) }
			} else {
				base, err := files(input["base"])
				if err != nil {
					return err
				}
				head, err := files(input["head"])
				if err != nil {
					return err
				}
				work = func() map[string]any { return snapshot(base, head) }
			}
			result, err := s.compute(ctx, work)
			if err != nil {
				return err
			}
			send(200, result, false)
			return nil
		}
		if method == "GET" && path == "/git" {
			gitctx, gitcancel := context.WithTimeout(ctx, 10*time.Second)
			defer gitcancel()
			command := exec.CommandContext(gitctx, "git", "-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--numstat", os.Getenv("GIT_BASE"), os.Getenv("GIT_HEAD"))
			command.Dir = os.Getenv("BENCHMARK_REPO")
			command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_NO_REPLACE_OBJECTS=1")
			output, err := command.Output()
			if err != nil {
				return err
			}
			if len(output) > 2*1024*1024 {
				return failure(413)
			}
			hash := sha256.Sum256(output)
			send(200, map[string]any{"bytes": len(output), "sha256": hex.EncodeToString(hash[:])}, false)
			return nil
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		digest := sha256.Sum256([]byte(token))
		users, err := d.query("auth", hex.EncodeToString(digest[:]))
		if err != nil {
			return err
		}
		if len(users) == 0 {
			return failure(401)
		}
		user := users[0][0].(string)
		if method == "GET" && path == "/hold" {
			if _, err := d.query("hold"); err != nil {
				return err
			}
			send(200, map[string]any{"ok": true}, false)
			return nil
		}
		match := roomRoute.FindStringSubmatch(path)
		if match != nil {
			room, operation := match[1], match[2]
			roles, err := d.query("gate", room, user)
			if err != nil {
				return err
			}
			role := roles[0][0].(string)
			if role == "" {
				return failure(403)
			}
			if method == "GET" && operation != "events" {
				rows, err := d.query(operation, room, user)
				if err != nil {
					return err
				}
				send(200, rows[0][0], true)
				return nil
			}
			if method == "GET" && operation == "events" {
				d.release()
				subscriber := &subscription{messages: make(chan []byte, 16), stop: make(chan struct{})}
				s.mu.Lock()
				if s.streams[room] == nil {
					s.streams[room] = map[*subscription]bool{}
				}
				s.streams[room][subscriber] = true
				s.mu.Unlock()
				s.open.Add(1)
				defer func() {
					s.mu.Lock()
					delete(s.streams[room], subscriber)
					if len(s.streams[room]) == 0 {
						delete(s.streams, room)
					}
					s.mu.Unlock()
					s.open.Add(-1)
				}()
				w.Header().Set("Content-Type", "text/event-stream")
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("Connection", "keep-alive")
				controller := http.NewResponseController(w)
				write := func(data []byte) error {
					_ = controller.SetWriteDeadline(time.Now().Add(time.Second))
					if _, err := w.Write(data); err != nil {
						return err
					}
					return controller.Flush()
				}
				if err := write([]byte(fmt.Sprintf("data: {\"ready\":%q}\n\n", room))); err != nil {
					return nil
				}
				ticker := time.NewTicker(25 * time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-r.Context().Done():
						return nil
					case <-subscriber.stop:
						return nil
					case message := <-subscriber.messages:
						if write(message) != nil {
							s.dropped.Add(1)
							return nil
						}
					case <-ticker.C:
						if write([]byte(": keepalive\n\n")) != nil {
							return nil
						}
					}
				}
			}
			if method == "POST" && operation == "events" {
				if role != "owner" && role != "editor" {
					return failure(403)
				}
				input, err := body(w, r)
				if err != nil {
					return err
				}
				id, message := text(input, "id"), text(input, "body")
				at, err := integer(input, "at", 0, 9007199254740991)
				var checkID, checkBody string
				idErr := json.Unmarshal(input["id"], &checkID)
				bodyErr := json.Unmarshal(input["body"], &checkBody)
				if err != nil || idErr != nil || bodyErr != nil || string(input["id"]) == "null" || string(input["body"]) == "null" || len(id) > 100 || len(message) > 4096 || input["id"] == nil || input["body"] == nil {
					return failure(400)
				}
				event, _ := json.Marshal(map[string]any{"id": id, "body": message, "at": at, "room": room})
				frame := append(append([]byte("data: "), event...), []byte("\n\n")...)
				s.mu.Lock()
				for subscriber := range s.streams[room] {
					select {
					case <-subscriber.stop:
					case subscriber.messages <- frame:
					default:
						s.dropped.Add(1)
						subscriber.close()
					}
				}
				s.mu.Unlock()
				send(200, map[string]any{"ok": true}, false)
				return nil
			}
			return failure(405)
		}
		if method == "POST" && path == "/tasks" {
			input, err := body(w, r)
			if err != nil {
				return err
			}
			id, run, room, assignee, message := text(input, "id"), text(input, "runId"), text(input, "room"), text(input, "assigneeId"), strings.TrimSpace(text(input, "body"))
			if !uuid.MatchString(id) || !uuid.MatchString(run) || !uuid.MatchString(assignee) || !roomPattern.MatchString(room) || message == "" || utf8.RuneCountInString(message) > 4000 {
				return failure(400)
			}
			if _, err := d.query("begin"); err != nil {
				return err
			}
			committed := false
			defer func() {
				if !committed {
					cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
					defer done()
					_, _ = d.conn.Exec(cleanup, "ROLLBACK")
				}
			}()
			allowed, err := d.query("allow", run, room, user, assignee)
			if err != nil {
				return err
			}
			if len(allowed) == 0 {
				return failure(403)
			}
			args := []any{id, run, user, assignee, message}
			if _, err := d.query("insert", args...); err != nil {
				return err
			}
			existing, err := d.query("existing", args...)
			if err != nil {
				return err
			}
			if len(existing) == 0 {
				return failure(409)
			}
			if _, err := d.query("commit"); err != nil {
				return err
			}
			committed = true
			send(201, map[string]any{"id": id}, false)
			return nil
		}
		if method == "PATCH" && strings.HasPrefix(path, "/tasks/") && uuid.MatchString(strings.TrimPrefix(path, "/tasks/")) {
			rows, err := d.query("complete", strings.TrimPrefix(path, "/tasks/"), user)
			if err != nil {
				return err
			}
			if len(rows) == 0 {
				return failure(403)
			}
			send(200, map[string]any{"ok": true}, false)
			return nil
		}
		return failure(404)
	}()
	if err != nil {
		if r.Context().Err() != nil {
			return
		}
		var rejected failure
		status := 500
		if errors.As(err, &rejected) {
			status = int(rejected)
		} else {
			s.errors.Add(1)
			log.Print(err)
		}
		send(status, map[string]any{"error": status}, false)
	}
}

func main() {
	schema := os.Getenv("BENCHMARK_SCHEMA")
	key := os.Getenv("BENCHMARK_KEY")
	if key == "" || !regexp.MustCompile(`^load_test_[a-f0-9]{32}$`).MatchString(schema) {
		log.Fatal("Only isolated benchmark fixtures are allowed")
	}
	threads, _ := strconv.Atoi(os.Getenv("COMPUTE_WORKERS"))
	if threads < 1 {
		threads = 4
	}
	runtime.GOMAXPROCS(threads)
	config, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	size, _ := strconv.Atoi(os.Getenv("DB_POOL"))
	if size < 1 {
		size = 10
	}
	config.MaxConns = int32(size)
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	config.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	data, err := os.ReadFile(os.Getenv("BENCHMARK_SQL"))
	if err != nil {
		log.Fatal(err)
	}
	queries := map[string]string{}
	if err = json.Unmarshal(data, &queries); err != nil {
		log.Fatal(err)
	}
	service := &service{pool: pool, sql: queries, key: key, slots: make(chan struct{}, threads), streams: map[string]map[*subscription]bool{}}
	listener, err := net.Listen("tcp", "127.0.0.1:"+os.Getenv("PORT"))
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(service.handler), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 70 * time.Second, MaxHeaderBytes: 16384}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		service.mu.Lock()
		for _, group := range service.streams {
			for subscriber := range group {
				subscriber.close()
			}
		}
		service.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	fmt.Printf("{\"port\":%d}\n", listener.Addr().(*net.TCPAddr).Port)
	if err = server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
