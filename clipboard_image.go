package main

import (
	"context"
	"io"
)

type contextPNGWriter struct {
	ctx context.Context
	w   io.Writer
}

func (w contextPNGWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.w.Write(p)
}
