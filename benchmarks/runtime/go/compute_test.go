package main

import (
	"context"
	"sync"
	"testing"
)

func TestGraphVectors(t *testing.T) {
	for _, v := range [][5]uint32{{16, 1, 0, 3233831135, 16}, {997, 7, 73, 3639982739, 6979}, {20000, 32, 73, 2122163898, 502741}, {25000, 64, 1000000, 753805657, 1527179}} {
		result := graph(v[0], v[1], v[2])
		if result["checksum"] != v[3] || result["visited"] != v[4] {
			t.Fatalf("graph %v: %v", v, result)
		}
	}
}

func TestSnapshotChanges(t *testing.T) {
	result := snapshot([]FileEntry{{"a", "a", 10}, {"b", "b", 20}, {"c", "c", 30}}, []FileEntry{{"a", "a", 10}, {"b", "d", 21}, {"d", "d", 40}})
	if result["added"] != 1 || result["modified"] != 1 || result["deleted"] != 1 || result["bytes"] != int64(61) {
		t.Fatal(result)
	}
}

func TestBoundedQueueAndRecovery(t *testing.T) {
	s := &service{slots: make(chan struct{}, 1)}
	s.slots <- struct{}{}
	s.queued.Store(257)
	if _, err := s.compute(context.Background(), func() map[string]any { t.Fatal("overloaded work executed"); return nil }); err != failure(503) {
		t.Fatal(err)
	}
	if s.queued.Load() != 257 {
		t.Fatal("counter leaked")
	}
	s.queued.Store(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.compute(ctx, func() map[string]any { t.Fatal("canceled work executed"); return nil }); err == nil {
		t.Fatal("expected cancellation")
	}
	<-s.slots
	s.queued.Store(0)
	var wg sync.WaitGroup
	for n := 0; n < 64; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.compute(context.Background(), func() map[string]any { return graph(997, 7, 73) }); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if s.queued.Load() != 0 || len(s.slots) != 0 {
		t.Fatal("queue leaked")
	}
}
