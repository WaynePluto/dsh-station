package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"
)

const loadingFrameLimit = 8 << 10
const loadingWriteTimeout = 3 * time.Second

// payload 必须由页面投影生成，不能放入含 token 的 backendObservation。
type loadingUpdate struct {
	payload any
	state   string
	changed <-chan struct{}
}

func (s *adminLoadingServer) readUpdate(expired bool) (update loadingUpdate) {
	update = s.page.failure
	defer func() {
		if recover() != nil {
			update = s.page.failure
		}
	}()
	return s.page.observe(expired)
}

func (s *adminLoadingServer) noteCompletion(state string) {
	if state == "failed" || (state == "ready" && s.page.finishOnReady) {
		s.terminalOnce.Do(func() { close(s.terminal) })
	}
}

// 一条请求先发送快照，之后只等待变更或单次期限，不使用轮询/心跳。
func (s *adminLoadingServer) serveEvents(w http.ResponseWriter, r *http.Request) {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		http.Error(w, "Streaming unavailable", http.StatusInternalServerError)
		return
	}
	defer func() { _ = controller.SetWriteDeadline(time.Now().Add(loadingWriteTimeout)) }()
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	timer := time.NewTimer(time.Until(s.page.deadline))
	defer timer.Stop()
	var previous []byte
	expired := !time.Now().Before(s.page.deadline)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		default:
		}
		expired = expired || !time.Now().Before(s.page.deadline)
		update := s.readUpdate(expired)
		frame, err := json.Marshal(update.payload)
		if err != nil || len(frame)+1 > loadingFrameLimit {
			return
		}
		if !bytes.Equal(previous, frame) {
			if err := controller.SetWriteDeadline(time.Now().Add(loadingWriteTimeout)); err != nil {
				return
			}
			if _, err := w.Write(append(frame, '\n')); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
			previous = frame
			if err := controller.SetWriteDeadline(time.Time{}); err != nil {
				return
			}
		}
		if update.state != "starting" {
			s.noteCompletion(update.state)
			return
		}
		// 到期投影必须终止，即使调用方错误地返回 starting 也不再等待。
		if expired {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		case <-update.changed:
		case <-timer.C:
			expired = true
		}
	}
}
