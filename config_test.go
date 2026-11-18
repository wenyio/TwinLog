package main

import (
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"
)

func TestSaveFullLogsConfigDefaultAndPersistence(t *testing.T) {
	settings := filepath.Join(t.TempDir(), "settings.json")
	if !loadConfig(settings, "default").SaveFullLogs {
		t.Fatal("new settings must default to full logs enabled")
	}
	if err := os.WriteFile(settings, []byte(`{"outputDir":"existing"}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := loadConfig(settings, "default")
	if !c.SaveFullLogs || c.OutputDir != "existing" {
		t.Fatalf("unexpected legacy settings: %+v", c)
	}
	c.SaveFullLogs = false
	a := &App{settings: settings}
	if err := a.SaveConfig(c); err != nil {
		t.Fatal(err)
	}
	if reloaded := loadConfig(settings, "default"); !reflect.DeepEqual(reloaded, c) {
		t.Fatalf("settings did not round-trip: %+v", reloaded)
	}
}

func TestCustomBaudRatesConfig(t *testing.T) {
	settings := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(settings, []byte(`{"baudRate":250000}`), 0600); err != nil {
		t.Fatal(err)
	}
	c := loadConfig(settings, "default")
	if c.BaudRate != 250000 || len(c.CustomBaudRates) != 0 {
		t.Fatalf("unexpected legacy baud settings: %+v", c)
	}
	c.BaudRate = 921600
	c.CustomBaudRates = []int{250000, 921600}
	a := &App{settings: settings}
	if err := a.SaveConfig(c); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig(settings, "default"); got.BaudRate != c.BaudRate || !slices.Equal(got.CustomBaudRates, c.CustomBaudRates) {
		t.Fatalf("baud settings did not round-trip: %+v", got)
	}
}

func TestPreviewLinesConfig(t *testing.T) {
	settings := filepath.Join(t.TempDir(), "settings.json")
	if c := loadConfig(settings, "default"); c.PreviewLines != 2000 {
		t.Fatalf("default preview lines = %d", c.PreviewLines)
	}
	a := &App{settings: settings}
	for _, test := range []struct{ input, want int }{{5000, 5000}, {10000, 10000}, {-1, 2000}} {
		c := a.GetConfig()
		c.PreviewLines = test.input
		if err := a.SaveConfig(c); err != nil {
			t.Fatal(err)
		}
		if got := loadConfig(settings, "default").PreviewLines; got != test.want {
			t.Fatalf("saved %d lines, got %d; want %d", test.input, got, test.want)
		}
	}
}
