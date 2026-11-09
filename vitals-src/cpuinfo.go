package main

import (
	"errors"
	"path/filepath"
	"strings"
	"time"
)

// ── CPU sensors ───────────────────────────────────────────────

type appCPU struct {
	Temp        *float64 `json:"temp"`
	Clock       *float64 `json:"clock"`
	ClockMax    *float64 `json:"clockMax"`
	Power       *float64 `json:"power"`
	PowerDenied bool     `json:"powerDenied,omitempty"`
	Hint        string   `json:"hint,omitempty"`
}

// cpuTempSensors are hwmon chips and the label of their package reading.
var cpuTempSensors = []struct{ chip, label string }{
	{"coretemp", "Package id 0"}, {"k10temp", "Tctl"}, {"zenpower", "Tctl"}, {"cpu_thermal", ""},
}

// cpuTemp is the CPU package temperature, in °C.
func cpuTemp() *float64 {
	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, want := range cpuTempSensors {
		for _, d := range dirs {
			if readTrim(filepath.Join(d, "name")) != want.chip {
				continue
			}
			inputs, _ := filepath.Glob(filepath.Join(d, "temp*_input"))
			for _, in := range inputs {
				if want.label != "" && readTrim(strings.TrimSuffix(in, "_input")+"_label") != want.label {
					continue
				}
				if v := optF(readTrim(in)); v != nil {
					c := *v / 1000
					return &c
				}
			}
		}
	}
	return nil
}

// cpuClock is the cores' average and highest rated clock, in MHz.
func cpuClock() (*float64, *float64) {
	dirs, _ := filepath.Glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq")
	sum, n, top := 0.0, 0, 0.0
	for _, d := range dirs {
		if v := optF(readTrim(filepath.Join(d, "scaling_cur_freq"))); v != nil {
			sum += *v / 1000
			n++
		}
		if v := optF(readTrim(filepath.Join(d, "cpuinfo_max_freq"))); v != nil {
			top = max(top, *v/1000)
		}
	}
	if n == 0 {
		return nil, nil
	}
	avg := sum / float64(n)
	if top == 0 {
		return &avg, nil
	}
	return &avg, &top
}

// readCPU reads the sensors, measuring power over a short span.
func readCPU(span time.Duration) appCPU {
	var c appCPU
	w, err := cpuPower(span)
	c.Temp = cpuTemp()
	c.Clock, c.ClockMax = cpuClock()
	switch {
	case err == nil:
		c.Power = w
	case errors.Is(err, errPMUDenied):
		c.PowerDenied, c.Hint = true, permissionHint()
	}
	return c
}
