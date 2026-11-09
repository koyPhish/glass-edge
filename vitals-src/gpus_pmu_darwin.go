package main

import (
	"errors"
	"time"
)

// ── Intel engine counters ─────────────────────────────────────

var errPMUDenied = errors.New("perf counters need CAP_PERFMON")

func intelEngines(slot string) (map[string]float64, error) { return nil, errors.New("no i915 PMU") }

func cpuPower(span time.Duration) (*float64, error) { return nil, errors.New("no RAPL") }
