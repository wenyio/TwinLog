package capture

type Config struct {
	OutputDir     string `json:"outputDir"`
	ADBPath       string `json:"adbPath"`
	SerialPort    string `json:"serialPort"`
	AndroidSerial string `json:"androidSerial"`
	Package       string `json:"package"`
	BaudRate      int    `json:"baudRate"`
	DataBits      int    `json:"dataBits"`
	StopBits      int    `json:"stopBits"`
	Parity        string `json:"parity"`
	DTR           bool   `json:"dtr"`
	RTS           bool   `json:"rts"`
	SaveFullLogs  bool   `json:"saveFullLogs"`
}

func (c Config) singleSource() string {
	switch {
	case c.AndroidSerial == "":
		return "mcu"
	case c.SerialPort == "":
		return "android"
	default:
		return ""
	}
}

type Record struct {
	Path        string `json:"path"`
	Title       string `json:"title"`
	Notes       string `json:"notes"`
	StartedAt   string `json:"startedAt"`
	EndedAt     string `json:"endedAt"`
	Package     string `json:"package"`
	Source      string `json:"source,omitempty"` // Empty for dual-source and legacy records.
	Interrupted bool   `json:"interrupted"`
	FilterGaps  bool   `json:"filterGaps,omitempty"`
}
type State struct {
	Connected     bool    `json:"connected"`
	Capturing     bool    `json:"capturing"`
	SessionDir    string  `json:"sessionDir"`
	ActiveRecord  *Record `json:"activeRecord"`
	Config        Config  `json:"config"`
	Error         string  `json:"error"`
	FilterStatus  string  `json:"filterStatus"`
	FilterWarning string  `json:"filterWarning"`
	McuBytes      uint64  `json:"mcuBytes"`
	AndroidBytes  uint64  `json:"androidBytes"`
}
type PortInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}
type Device struct {
	Serial string `json:"serial"`
	State  string `json:"state"`
	Model  string `json:"model"`
}
type LogBatch struct {
	Source string `json:"source"`
	Text   string `json:"text"`
}
