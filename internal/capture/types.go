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
}
type Record struct {
	Path        string `json:"path"`
	Title       string `json:"title"`
	Notes       string `json:"notes"`
	StartedAt   string `json:"startedAt"`
	EndedAt     string `json:"endedAt"`
	Package     string `json:"package"`
	Interrupted bool   `json:"interrupted"`
}
type State struct {
	Connected    bool    `json:"connected"`
	Capturing    bool    `json:"capturing"`
	SessionDir   string  `json:"sessionDir"`
	ActiveRecord *Record `json:"activeRecord"`
	Config       Config  `json:"config"`
	Error        string  `json:"error"`
	McuBytes     uint64  `json:"mcuBytes"`
	AndroidBytes uint64  `json:"androidBytes"`
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
