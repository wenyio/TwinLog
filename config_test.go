package main

import (
	"os"
	"path/filepath"
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
	if reloaded := loadConfig(settings, "default"); reloaded != c {
		t.Fatalf("settings did not round-trip: %+v", reloaded)
	}
}
