package main

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ── Intel engine counters ─────────────────────────────────────

type pmuCounter struct {
	label string
	fd    int
}

// pmuSet is one GPU's open counters and their last reading.
type pmuSet struct {
	counters []pmuCounter
	last     []uint64
	at       time.Time
}

var (
	pmuMu   sync.Mutex
	pmuSets = map[string]*pmuSet{}
	pmuDeny = map[string]bool{}
)

var errPMUDenied = errors.New("perf counters need CAP_PERFMON")

// pmuDir is the i915 PMU for a PCI slot.
func pmuDir(slot string) string {
	base := "/sys/bus/event_source/devices/"
	if d := base + "i915_" + strings.ReplaceAll(slot, ":", "_"); exists(d) {
		return d
	}
	if exists(base + "i915") {
		return base + "i915"
	}
	return ""
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func eventConfig(dir, name string) (uint64, bool) {
	s := readTrim(filepath.Join(dir, "events", name))
	v, ok := strings.CutPrefix(s, "config=")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(v, "0x"), 16, 64)
	return n, err == nil
}

func openPMU(slot string) (*pmuSet, error) {
	dir := pmuDir(slot)
	if dir == "" {
		return nil, errors.New("no i915 PMU")
	}
	typ, err := strconv.ParseUint(readTrim(filepath.Join(dir, "type")), 10, 32)
	if err != nil {
		return nil, err
	}
	cpu, _ := strconv.Atoi(strings.SplitN(strings.SplitN(readTrim(filepath.Join(dir, "cpumask")), ",", 2)[0], "-", 2)[0])
	events, _ := filepath.Glob(filepath.Join(dir, "events", "*-busy"))
	set := &pmuSet{}
	for _, e := range events {
		name := filepath.Base(e)
		label := ""
		for _, p := range pmuEngines {
			if strings.HasPrefix(name, p.prefix) && len(name) > len(p.prefix) && name[len(p.prefix)] >= '0' && name[len(p.prefix)] <= '9' {
				label = p.label
			}
		}
		cfg, ok := eventConfig(dir, name)
		if label == "" || !ok {
			continue
		}
		attr := unix.PerfEventAttr{Type: uint32(typ), Config: cfg, Size: uint32(unsafe.Sizeof(unix.PerfEventAttr{}))}
		fd, err := unix.PerfEventOpen(&attr, -1, cpu, -1, unix.PERF_FLAG_FD_CLOEXEC)
		if err != nil {
			set.close()
			if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
				return nil, errPMUDenied
			}
			return nil, err
		}
		set.counters = append(set.counters, pmuCounter{label, fd})
	}
	if len(set.counters) == 0 {
		return nil, errors.New("no busy events")
	}
	set.last, set.at = set.read(), time.Now()
	return set, nil
}

func (s *pmuSet) read() []uint64 {
	out := make([]uint64, len(s.counters))
	buf := make([]byte, 8)
	for i, c := range s.counters {
		if n, err := unix.Read(c.fd, buf); err == nil && n == 8 {
			out[i] = binary.LittleEndian.Uint64(buf)
		}
	}
	return out
}

func (s *pmuSet) close() {
	for _, c := range s.counters {
		unix.Close(c.fd)
	}
}

// busy is each engine group's busiest share since the last call.
func (s *pmuSet) busy() map[string]float64 {
	now, at := s.read(), time.Now()
	dt := float64(at.Sub(s.at).Nanoseconds())
	out := map[string]float64{}
	for i, c := range s.counters {
		v := 0.0
		if dt > 0 && now[i] >= s.last[i] {
			v = clamp100(100 * float64(now[i]-s.last[i]) / dt)
		}
		out[c.label] = max(out[c.label], v)
	}
	s.last, s.at = now, at
	return out
}

// intelEngines reads engine load; a fresh set waits briefly for its first span.
func intelEngines(slot string) (map[string]float64, error) {
	pmuMu.Lock()
	defer pmuMu.Unlock()
	if pmuDeny[slot] {
		return nil, errPMUDenied
	}
	set, ok := pmuSets[slot]
	if !ok {
		var err error
		if set, err = openPMU(slot); err != nil {
			if errors.Is(err, errPMUDenied) {
				pmuDeny[slot] = true
			}
			return nil, err
		}
		pmuSets[slot] = set
		time.Sleep(250 * time.Millisecond)
	}
	return set.busy(), nil
}
