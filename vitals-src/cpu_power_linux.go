package main

import (
	"encoding/binary"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// ── CPU package power ─────────────────────────────────────────

const powerPMU = "/sys/bus/event_source/devices/power"

// cpuPower is the package's draw in watts, from the RAPL energy counter over span.
func cpuPower(span time.Duration) (*float64, error) {
	typ, err := strconv.ParseUint(readTrim(filepath.Join(powerPMU, "type")), 10, 32)
	if err != nil {
		return nil, errors.New("no power PMU")
	}
	ev, ok := strings.CutPrefix(readTrim(filepath.Join(powerPMU, "events", "energy-pkg")), "event=")
	if !ok {
		return nil, errors.New("no energy-pkg event")
	}
	cfg, err := strconv.ParseUint(strings.TrimPrefix(ev, "0x"), 16, 64)
	if err != nil {
		return nil, err
	}
	scale, err := strconv.ParseFloat(readTrim(filepath.Join(powerPMU, "events", "energy-pkg.scale")), 64)
	if err != nil {
		return nil, err
	}
	cpu, _ := strconv.Atoi(strings.SplitN(strings.SplitN(readTrim(filepath.Join(powerPMU, "cpumask")), ",", 2)[0], "-", 2)[0])
	attr := unix.PerfEventAttr{Type: uint32(typ), Config: cfg, Size: uint32(unsafe.Sizeof(unix.PerfEventAttr{}))}
	fd, err := unix.PerfEventOpen(&attr, -1, cpu, -1, unix.PERF_FLAG_FD_CLOEXEC)
	if err != nil {
		if errors.Is(err, unix.EACCES) || errors.Is(err, unix.EPERM) {
			return nil, errPMUDenied
		}
		return nil, err
	}
	defer unix.Close(fd)
	read := func() (uint64, error) {
		buf := make([]byte, 8)
		if n, err := unix.Read(fd, buf); err != nil || n != 8 {
			return 0, errors.New("short read")
		}
		return binary.LittleEndian.Uint64(buf), nil
	}
	a, at := uint64(0), time.Now()
	if a, err = read(); err != nil {
		return nil, err
	}
	time.Sleep(span)
	b, err := read()
	if err != nil || b < a {
		return nil, errors.New("no reading")
	}
	w := float64(b-a) * scale / time.Since(at).Seconds()
	return &w, nil
}
