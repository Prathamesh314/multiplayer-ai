package main

import "sort"

type FileEntry struct {
	Path string `json:"path"`
	SHA  string `json:"sha"`
	Size int64  `json:"size"`
}

func graph(nodes, rounds, seed uint32) map[string]any {
	seen, queue := make([]uint32, nodes), make([]uint32, nodes)
	checksum, visited := uint32(2166136261), uint32(0)
	for round := uint32(1); round <= rounds; round++ {
		start, end := 0, 1
		queue[0] = (seed + round) % nodes
		seen[queue[0]] = round
		for start < end {
			node := queue[start]
			start++
			visited++
			checksum = (checksum ^ node) * 16777619
			for edge := uint32(0); edge < 8; edge++ {
				next := ((node+1)*1664525 + (edge+seed)*1013904223) % nodes
				if seen[next] != round {
					seen[next] = round
					queue[end] = next
					end++
				}
			}
		}
	}
	return map[string]any{"checksum": checksum, "visited": visited}
}

func snapshot(base, head []FileEntry) map[string]any {
	old := make(map[string]FileEntry, len(base))
	for _, file := range base {
		old[file.Path] = file
	}
	added, modified, deleted := 0, 0, 0
	var bytes int64
	checksum := uint32(2166136261)
	changed := []string{}
	for _, file := range head {
		previous, exists := old[file.Path]
		delete(old, file.Path)
		if !exists {
			added++
		} else if previous.SHA != file.SHA || previous.Size != file.Size {
			modified++
		} else {
			continue
		}
		bytes += file.Size
		changed = append(changed, file.Path)
	}
	for path := range old {
		deleted++
		changed = append(changed, path)
	}
	sort.Strings(changed)
	for _, path := range changed {
		for i := 0; i < len(path); i++ {
			checksum = (checksum ^ uint32(path[i])) * 16777619
		}
	}
	return map[string]any{"added": added, "modified": modified, "deleted": deleted, "bytes": bytes, "checksum": checksum}
}
