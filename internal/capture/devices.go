package capture

import (
	"context"
	"fmt"
	"go.bug.st/serial/enumerator"
	"os/exec"
	"sort"
	"strings"
	"time"
)

func command(ctx context.Context, adb string, args ...string) *exec.Cmd {
	if strings.TrimSpace(adb) == "" {
		adb = "adb"
	}
	cmd := exec.CommandContext(ctx, adb, args...)
	hideWindow(cmd)
	return cmd
}
func adbOutput(adb string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	out, err := command(ctx, adb, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("ADB: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}
func ListPorts() ([]PortInfo, error) {
	ports, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return nil, err
	}
	out := []PortInfo{}
	for _, p := range ports {
		desc := p.Product
		if p.IsUSB {
			desc += fmt.Sprintf(" USB %s:%s", p.VID, p.PID)
		}
		out = append(out, PortInfo{p.Name, strings.TrimSpace(desc)})
	}
	return out, nil
}
func ListDevices(adb string) ([]Device, error) {
	text, err := adbOutput(adb, "devices", "-l")
	if err != nil {
		return nil, err
	}
	out := []Device{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] == "List" || strings.HasPrefix(f[0], "*") {
			continue
		}
		d := Device{Serial: f[0], State: f[1]}
		for _, v := range f[2:] {
			if strings.HasPrefix(v, "model:") {
				d.Model = strings.ReplaceAll(strings.TrimPrefix(v, "model:"), "_", " ")
			}
		}
		out = append(out, d)
	}
	return out, nil
}
func ListPackages(adb, serial string) ([]string, error) {
	if serial == "" {
		return nil, fmt.Errorf("请先选择 Android 设备")
	}
	text, err := adbOutput(adb, "-s", serial, "shell", "pm", "list", "packages")
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "package:") {
			out = append(out, strings.TrimSpace(strings.TrimPrefix(line, "package:")))
		}
	}
	sort.Strings(out)
	return out, nil
}
