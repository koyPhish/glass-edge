package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── GPU devices ───────────────────────────────────────────────

// gpuDev is one GPU as read, before rates.
type gpuDev struct {
	ID, Kind, Name               string
	Util, Enc, Dec               *float64
	MemUsed, MemTotal            *float64 // bytes
	Temp, Fan, Power, PowerLimit *float64
	Clock, ClockMax              *float64
	Queues                       map[string][2]float64 // V3D queue to timestamp and busy time, ns
	Engines                      map[string]float64    // Intel engine group to busy %
	PMUDenied                    bool
	Integrated, Display          bool
}

func optF(s string) *float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return nil
	}
	return &v
}

func scaled(v *float64, k float64) *float64 {
	if v == nil {
		return nil
	}
	x := *v * k
	return &x
}

func readTrim(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func firstGlob(pattern string) string {
	m, _ := filepath.Glob(pattern)
	if len(m) == 0 {
		return ""
	}
	return readTrim(m[0])
}

// ── Device names ──────────────────────────────────────────────

var (
	gpuNamesMu sync.Mutex
	gpuNames   = map[string]string{}
	bracketed  = regexp.MustCompile(`\[([^\]]+)\]`)
)

// pciName is the device's model from lspci, cached per slot.
func pciSlot(dev string) string {
	if real, err := filepath.EvalSymlinks(dev); err == nil {
		return filepath.Base(real)
	}
	return filepath.Base(dev)
}

func pciName(dev string, fallback string) string {
	slot := pciSlot(dev)
	gpuNamesMu.Lock()
	defer gpuNamesMu.Unlock()
	if n, ok := gpuNames[slot]; ok {
		return n
	}
	name := fallback
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "lspci", "-s", slot).Output(); err == nil {
		line := strings.TrimSpace(string(out))
		if m := bracketed.FindStringSubmatch(line); m != nil {
			name = m[1]
		} else if i := strings.Index(line, ": "); i >= 0 {
			name = strings.TrimSpace(regexp.MustCompile(` \(rev .*\)$`).ReplaceAllString(line[i+2:], ""))
		}
	}
	gpuNames[slot] = name
	return name
}

func shortNvidia(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimPrefix(name, "NVIDIA ")
	return strings.TrimPrefix(name, "GeForce ")
}

// ── Readers ───────────────────────────────────────────────────

func readNvidia() []gpuDev {
	if _, err := exec.LookPath("nvidia-smi"); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "nvidia-smi",
		"--query-gpu=index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.sm,clocks.max.sm",
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil
	}
	var devs []gpuDev
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Split(line, ", ")
		if len(f) < 13 {
			continue
		}
		devs = append(devs, gpuDev{
			ID: "nv" + strings.TrimSpace(f[0]), Kind: "nvidia", Name: shortNvidia(f[1]),
			Util: optF(f[2]), Enc: optF(f[3]), Dec: optF(f[4]),
			MemUsed: scaled(optF(f[5]), 1<<20), MemTotal: scaled(optF(f[6]), 1<<20),
			Temp: optF(f[7]), Power: optF(f[8]), PowerLimit: optF(f[9]), Fan: optF(f[10]),
			Clock: optF(f[11]), ClockMax: optF(f[12]),
		})
	}
	return devs
}

func readDRM() []gpuDev {
	cards, _ := filepath.Glob("/sys/class/drm/card[0-9]*")
	var devs []gpuDev
	for _, c := range cards {
		n := filepath.Base(c)
		if strings.Contains(n, "-") {
			continue
		}
		d := filepath.Join(c, "device")
		if readTrim(filepath.Join(d, "vendor")) == "0x10de" {
			continue
		}
		switch {
		case readTrim(filepath.Join(d, "gpu_busy_percent")) != "":
			devs = append(devs, gpuDev{
				ID: n, Kind: "amd", Name: pciName(d, "AMD GPU"),
				Util:    optF(readTrim(filepath.Join(d, "gpu_busy_percent"))),
				MemUsed: optF(readTrim(filepath.Join(d, "mem_info_vram_used"))), MemTotal: optF(readTrim(filepath.Join(d, "mem_info_vram_total"))),
				Temp:  scaled(optF(firstGlob(filepath.Join(d, "hwmon/hwmon*/temp1_input"))), 1e-3),
				Power: scaled(optF(firstGlob(filepath.Join(d, "hwmon/hwmon*/power1_average"))), 1e-6),
			})
		case readTrim(filepath.Join(c, "gt_act_freq_mhz")) != "":
			devs = append(devs, intelDev(n, c, d, filepath.Join(c, "gt_act_freq_mhz"), filepath.Join(c, "gt_RP0_freq_mhz")))
		case readTrim(filepath.Join(d, "tile0/gt0/freq0/act_freq")) != "":
			devs = append(devs, intelDev(n, c, d, filepath.Join(d, "tile0/gt0/freq0/act_freq"), filepath.Join(d, "tile0/gt0/freq0/rp0_freq")))
		default:
			if g, ok := readV3D(n, d); ok {
				devs = append(devs, g)
			}
		}
	}
	return devs
}

func readV3D(id, dev string) (gpuDev, bool) {
	data, err := os.ReadFile(filepath.Join(dev, "gpu_stats"))
	if err != nil {
		return gpuDev{}, false
	}
	g := gpuDev{ID: id, Kind: "v3d", Name: "V3D", Queues: map[string][2]float64{},
		Temp: scaled(optF(readTrim("/sys/class/thermal/thermal_zone0/temp")), 1e-3)}
	for i, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 4 {
			continue
		}
		ts, e1 := strconv.ParseFloat(f[1], 64)
		rt, e2 := strconv.ParseFloat(f[3], 64)
		if e1 == nil && e2 == nil {
			g.Queues[f[0]] = [2]float64{ts, rt}
		}
	}
	return g, true
}

func intelDev(id, card, dev, act, rp0 string) gpuDev {
	slot := pciSlot(dev)
	g := gpuDev{ID: id, Kind: "intel", Name: pciName(dev, "Intel GPU"),
		Clock: optF(readTrim(act)), ClockMax: optF(readTrim(rp0)),
		Integrated: strings.HasPrefix(slot, "0000:00:"), Display: hasDisplay(card)}
	if g.Integrated && hasDiscrete() && !g.Display {
		return g
	}
	if e, err := intelEngines(slot); err == nil {
		g.Engines = e
	} else if errors.Is(err, errPMUDenied) {
		g.PMUDenied = true
	}
	return g
}

func hasDisplay(card string) bool {
	ss, _ := filepath.Glob(card + "-*/status")
	for _, s := range ss {
		if readTrim(s) == "connected" {
			return true
		}
	}
	return false
}

// hasDiscrete is whether a GPU off the root PCI bus exists.
func hasDiscrete() bool {
	cards, _ := filepath.Glob("/sys/class/drm/card[0-9]*")
	for _, c := range cards {
		if strings.Contains(filepath.Base(c), "-") {
			continue
		}
		slot := pciSlot(filepath.Join(c, "device"))
		if strings.HasPrefix(slot, "0000:") && !strings.HasPrefix(slot, "0000:00:") {
			return true
		}
	}
	return false
}

// readGPUDevices reads every GPU on this machine, leaving out an idle iGPU beside a discrete one.
func readGPUDevices() []gpuDev {
	var out []gpuDev
	for _, g := range append(readNvidia(), readDRM()...) {
		if g.Integrated && !g.Display && hasDiscrete() {
			continue
		}
		out = append(out, g)
	}
	return out
}

// pmuEngines maps i915 busy events to band labels.
var pmuEngines = []struct{ prefix, label string }{
	{"rcs", "RNDR"}, {"bcs", "COPY"}, {"vcs", "VID"}, {"vecs", "VE"}, {"ccs", "CMP"},
}

// ── Views ─────────────────────────────────────────────────────

type appBand struct {
	Label string   `json:"label"`
	Pct   *float64 `json:"pct"`
}

// appGPU is one GPU as the mod draws it.
type appGPU struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Util       *float64  `json:"util"`
	ClockOnly  bool      `json:"clockOnly,omitempty"`
	Bands      []appBand `json:"bands"`
	VramUsed   *float64  `json:"vramUsed"`
	VramTotal  *float64  `json:"vramTotal"`
	Power      *float64  `json:"power"`
	PowerLimit *float64  `json:"powerLimit"`
	Temp       *float64  `json:"temp"`
	Clock      *float64  `json:"clock"`
	Hint       string    `json:"hint,omitempty"`
}

// permissionHint is the command that lets this binary read GPU counters.
func permissionHint() string {
	self, err := os.Executable()
	if err != nil {
		self = "vitals"
	}
	return "sudo setcap cap_perfmon+ep " + self + " && pkill -x vitals"
}

func pctOf(a, b *float64) *float64 {
	if a == nil || b == nil || *b <= 0 {
		return nil
	}
	v := clamp100(100 * *a / *b)
	return &v
}

func clamp100(v float64) float64 { return max(0, min(100, v)) }

var v3dQueues = []struct{ key, label string }{{"bin", "BIN"}, {"render", "RNDR"}, {"tfu", "TFU"}, {"csd", "CSD"}}

// gpuViews turns readings into bands, with rates against prev.
func gpuViews(cur, prev []gpuDev) []appGPU {
	out := []appGPU{}
	for _, g := range cur {
		v := appGPU{ID: g.ID, Name: g.Name, VramUsed: g.MemUsed, VramTotal: g.MemTotal, Power: g.Power, PowerLimit: g.PowerLimit, Temp: g.Temp, Clock: g.Clock}
		switch g.Kind {
		case "nvidia":
			v.Util = g.Util
			v.Bands = []appBand{{"GPU", g.Util},
				{"VRAM", pctOf(g.MemUsed, g.MemTotal)}, {"PWR", pctOf(g.Power, g.PowerLimit)},
				{"TEMP", g.Temp}, {"FAN", g.Fan}, {"CLK", pctOf(g.Clock, g.ClockMax)}}
		case "amd":
			v.Util = g.Util
			v.Bands = []appBand{{"GPU", g.Util}, {"VRAM", pctOf(g.MemUsed, g.MemTotal)}, {"TEMP", g.Temp}}
		case "intel":
			clk := pctOf(g.Clock, g.ClockMax)
			if g.Engines == nil {
				v.Util = clk
				v.ClockOnly = true
				v.Bands = []appBand{{"CLK", clk}}
				if g.PMUDenied {
					v.Hint = permissionHint()
				}
				break
			}
			for _, e := range pmuEngines {
				if b, ok := g.Engines[e.label]; ok {
					v.Bands = append(v.Bands, appBand{e.label, &b})
					if v.Util == nil || b > *v.Util {
						u := b
						v.Util = &u
					}
				}
			}
			v.Bands = append(v.Bands, appBand{"CLK", clk})
		case "v3d":
			var was map[string][2]float64
			for _, p := range prev {
				if p.ID == g.ID {
					was = p.Queues
				}
			}
			for _, q := range v3dQueues {
				now, ok := g.Queues[q.key]
				then, okp := was[q.key]
				var busy *float64
				if ok && okp && now[0] > then[0] {
					b := clamp100(100 * (now[1] - then[1]) / (now[0] - then[0]))
					busy = &b
					if v.Util == nil || b > *v.Util {
						v.Util = &b
					}
				}
				v.Bands = append(v.Bands, appBand{q.label, busy})
			}
			v.Bands = append(v.Bands, appBand{"TEMP", g.Temp})
		}
		out = append(out, v)
	}
	return out
}

// gpuUtils is each GPU's headline load, for history points.
func gpuUtils(cur, prev []gpuDev) map[string]float64 {
	var m map[string]float64
	for _, v := range gpuViews(cur, prev) {
		if v.Util == nil {
			continue
		}
		if m == nil {
			m = map[string]float64{}
		}
		m[v.ID] = round1(*v.Util)
	}
	return m
}
