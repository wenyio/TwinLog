//go:build !windows

package capture

import "fmt"

func deleteWithShell([]string) error {
	return fmt.Errorf("此平台不支持系统删除记录")
}
