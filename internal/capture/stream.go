package capture

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// TimestampStream never buffers an entire line; CRLF is one logical newline.
type TimestampStream struct {
	start   bool
	afterCR bool
	stamp   string
}

func (s *TimestampStream) Transform(data []byte, at time.Time) []byte {
	var out bytes.Buffer
	for _, b := range data {
		if s.afterCR {
			s.afterCR = false
			if b == '\n' {
				out.WriteByte(b)
				continue
			}
		}
		if !s.start {
			s.stamp = at.Format("[2006-01-02 15:04:05.000] ")
			out.WriteString(s.stamp)
			s.start = true
		}
		out.WriteByte(b)
		if b == '\r' {
			s.start = false
			s.afterCR = true
		} else if b == '\n' {
			s.start = false
		}
	}
	return out.Bytes()
}
func (s *TimestampStream) Prefix() string {
	if s.start {
		return s.stamp
	}
	return ""
}

type appIdentity struct {
	uid    string
	shared bool
}

func resolveIdentity(adb, serial, pkg string) (appIdentity, error) {
	if pkg == "" {
		return appIdentity{}, nil
	}
	for _, r := range pkg {
		if !(r == '.' || r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return appIdentity{}, fmt.Errorf("应用包名格式不正确")
		}
	}
	text, err := adbOutput(adb, "-s", serial, "shell", "pm", "list", "packages", "-U")
	if err != nil {
		return appIdentity{}, err
	}
	return parseIdentity(text, pkg)
}
func parseIdentity(text, pkg string) (appIdentity, error) {
	uids := map[string][]string{}
	target := ""
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		name := strings.TrimPrefix(f[0], "package:")
		uid := strings.TrimPrefix(f[1], "uid:")
		uids[uid] = append(uids[uid], name)
		if name == pkg {
			target = uid
		}
	}
	if target == "" {
		return appIdentity{}, fmt.Errorf("未找到应用 %s 或设备未提供 UID", pkg)
	}
	return appIdentity{uid: target, shared: len(uids[target]) > 1}, nil
}
func normalizedUID(uid string) string {
	if _, e := strconv.Atoi(uid); e == nil {
		return uid
	}
	var user, app int
	if _, e := fmt.Sscanf(uid, "u%d_a%d", &user, &app); e == nil {
		return strconv.Itoa(user*100000 + 10000 + app)
	}
	if _, e := fmt.Sscanf(uid, "u%d_s%d", &user, &app); e == nil {
		return strconv.Itoa(user*100000 + app)
	}
	return uid
}

// threadtime + uid: date time UID PID TID priority tag: message
func uidMatch(prefix []byte, uid string) bool {
	f := bytes.Fields(prefix)
	if len(f) < 7 {
		return false
	}
	return normalizedUID(string(f[2])) == uid
}

type AndroidFilter struct {
	uid            string
	pidOnly        bool
	pids           map[string]bool
	prefix         []byte
	decided, match bool
	packageName    string
	systemPID      string
	lifecycle      []byte
}

func (f *AndroidFilter) SetUID(uid string) {
	f.uid = uid
	f.pidOnly = false
	f.pids = nil
	f.packageName = ""
	f.systemPID = ""
	f.lifecycle = nil
	f.prefix = nil
	f.decided = false
	f.match = false
}
func (f *AndroidFilter) SetPIDs(uid string, pids map[string]bool) {
	f.SetUID(uid)
	f.pidOnly = true
	f.pids = pids
}
func (f *AndroidFilter) UpdatePIDs(pids map[string]bool) { f.pids = pids }
func (f *AndroidFilter) matches(prefix []byte) bool {
	if !uidMatch(prefix, f.uid) {
		return false
	}
	if !f.pidOnly {
		return true
	}
	fields := bytes.Fields(prefix)
	return f.pids[string(fields[3])]
}
func (f *AndroidFilter) Feed(data []byte) []byte {
	if f.uid == "" {
		return data
	}
	var out bytes.Buffer
	for len(data) > 0 {
		n := bytes.IndexByte(data, '\n')
		end := len(data)
		newline := n >= 0
		if newline {
			end = n + 1
		}
		part := data[:end]
		data = data[end:]
		if f.pidOnly && len(f.lifecycle) < 4096 {
			take := len(part)
			if take > 4096-len(f.lifecycle) {
				take = 4096 - len(f.lifecycle)
			}
			f.lifecycle = append(f.lifecycle, part[:take]...)
		}
		if f.decided {
			if f.match {
				out.Write(part)
			}
		} else {
			// Only a small header prefix is retained, not arbitrarily long messages.
			take := len(part)
			if take > 256-len(f.prefix) {
				take = 256 - len(f.prefix)
			}
			f.prefix = append(f.prefix, part[:take]...)
			if len(bytes.Fields(f.prefix)) >= 7 || newline || len(f.prefix) >= 256 {
				f.match = f.matches(f.prefix)
				f.decided = true
				if f.match {
					out.Write(f.prefix)
					out.Write(part[take:])
				}
				f.prefix = nil
			}
		}
		if newline {
			if f.pidOnly {
				f.observeProcess(f.lifecycle)
				f.lifecycle = nil
			}
			f.prefix = nil
			f.decided = false
			f.match = false
		}
	}
	return out.Bytes()
}

var startProc = regexp.MustCompile("Start proc ([0-9]+):([^/ ]+)/")
var diedProc = regexp.MustCompile("Process ([^ ]+) \\(pid ([0-9]+)\\) has died")

func (f *AndroidFilter) owns(name string) bool {
	return name == f.packageName || strings.HasPrefix(name, f.packageName+":")
}
func (f *AndroidFilter) observeProcess(line []byte) {
	if f.packageName == "" {
		return
	}
	fields := bytes.Fields(line)
	if len(fields) < 7 {
		return
	}
	// Only system ActivityManager/event records can update process identity.
	if normalizedUID(string(fields[2])) != "1000" || f.systemPID == "" || string(fields[3]) != f.systemPID {
		return
	}
	tag := string(fields[6])
	if tag != "ActivityManager:" && tag != "am_proc_start:" && tag != "am_proc_died:" {
		return
	}
	text := string(line)
	if tag == "ActivityManager:" {
		if v := startProc.FindStringSubmatch(text); len(v) == 3 && f.owns(v[2]) {
			f.pids[v[1]] = true
		}
		if v := diedProc.FindStringSubmatch(text); len(v) == 3 && f.owns(v[1]) {
			delete(f.pids, v[2])
		}
		return
	}
	i := strings.IndexByte(text, '[')
	j := strings.LastIndexByte(text, ']')
	if i < 0 || j <= i {
		return
	}
	values := strings.Split(text[i+1:j], ",")
	nameIndex := 3
	if tag == "am_proc_died:" {
		nameIndex = 2
	}
	if len(values) <= nameIndex {
		return
	}
	pid := strings.TrimSpace(values[1])
	name := strings.TrimSpace(values[nameIndex])
	if !f.owns(name) {
		return
	}
	if _, e := strconv.Atoi(pid); e != nil {
		return
	}
	if tag == "am_proc_start:" {
		f.pids[pid] = true
	} else {
		delete(f.pids, pid)
	}
}
