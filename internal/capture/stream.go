package capture

import (
	"bytes"
	"fmt"
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

func resolveUID(adb, serial, pkg string) (string, error) {
	if pkg == "" {
		return "", nil
	}
	for _, r := range pkg {
		if !(r == '.' || r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return "", fmt.Errorf("应用包名格式不正确")
		}
	}
	text, err := adbOutput(adb, "-s", serial, "shell", "pm", "list", "packages", "-U")
	if err != nil {
		return "", err
	}
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
		return "", fmt.Errorf("未找到应用 %s 或设备未提供 UID", pkg)
	}
	if len(uids[target]) > 1 {
		return "", fmt.Errorf("应用共享 UID，无法准确单独过滤：%s", strings.Join(uids[target], ", "))
	}
	return target, nil
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
	prefix         []byte
	decided, match bool
}

func (f *AndroidFilter) SetUID(uid string) {
	f.uid = uid
	f.prefix = nil
	f.decided = false
	f.match = false
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
				f.match = uidMatch(f.prefix, f.uid)
				f.decided = true
				if f.match {
					out.Write(f.prefix)
					out.Write(part[take:])
				}
				f.prefix = nil
			}
		}
		if newline {
			f.prefix = nil
			f.decided = false
			f.match = false
		}
	}
	return out.Bytes()
}
