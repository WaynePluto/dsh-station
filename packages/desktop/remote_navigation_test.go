package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"testing/synctest"
	"time"
)

func TestRemoteFallbackRejectsInvalidTargets(t *testing.T) {
	for _, change := range []func(*backendStatus){
		func(s *backendStatus) { s.HasURLs = false },
		func(s *backendStatus) { s.DshToken = "" },
		func(s *backendStatus) { s.URLs.Dsh = "https://example.com/" },
		func(s *backendStatus) { s.URLs.Dsh += "path" },
		func(s *backendStatus) { s.URLs.Admin = "http://127.0.0.1:31809/_admin/extra" },
		func(s *backendStatus) { s.URLs.Local = "http://127.0.0.1:9999/" },
		func(s *backendStatus) { s.URLs.Admin = s.URLs.Dsh + "_admin"; s.URLs.Local = s.URLs.Dsh },
	} {
		status := remoteControlStatus("ready")
		change(&status)
		if script, err := remoteFallbackScript(status); err == nil || script != "" {
			t.Fatal("无效目标不能生成导航脚本")
		}
	}
}

func TestRemoteFallbackClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	status := remoteControlStatus("ready")
	status.DshToken = "private-token/&?\"'<>"
	script, err := remoteFallbackScript(status)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, node, "-e", remoteFallbackNodeTests)
	command.Stdin = strings.NewReader(script)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("条件导航脚本测试失败：%v\n%s", err, output)
	}
}

const remoteFallbackNodeTests = `
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(0, 'utf8');
for (const [address, redirect, frame = false] of [
  ['http://127.0.0.1:31809/_admin', true],
  ['http://127.0.0.1:31809/_admin/machines?x=1', true],
  ['http://127.0.0.1:31809/_setup', true],
  ['http://127.0.0.1:31809/', true],
  ['http://127.0.0.1:3180/', false],
  ['http://127.0.0.1:3180/session/active', false],
  ['http://127.0.0.1:9999/_admin', false],
  ['https://127.0.0.1:31809/_admin', false],
  ['https://example.com/_admin', false],
  ['http://127.0.0.1:31809/_admin', false, true],
]) {
  const calls = [], handlers = new Map();
  const draft = {text: 'unsent local draft'};
  const window = {
    draft,
    addEventListener(name, callback, capture) { assert.equal(capture, true); handlers.set(name, callback); },
    stop() { calls.push('stop'); }
  };
  window.top = frame ? {} : window;
  const context = vm.createContext({window, location: {
    origin: new URL(address).origin,
    replace(target) {
      const parsed = new URL(target);
      assert.equal(parsed.origin, 'http://127.0.0.1:3180');
      assert.equal(parsed.pathname, '/');
      assert.ok(parsed.searchParams.get('token') === 'private-token/&?"\'<>');
      assert.equal([...parsed.searchParams].length, 1);
      calls.push('replace');
    },
    assign() { throw new Error('must replace offline history, not append'); }
  }});
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.deepEqual(calls, redirect ? ['stop', 'replace'] : []);
  assert.equal(window.draft, draft);
  assert.equal(window.draft.text, 'unsent local draft');
  assert.equal(handlers.size, redirect ? 2 : 0);
  for (const callback of handlers.values()) {
    let prevented = 0;
    callback({preventDefault() { prevented++; }, stopImmediatePropagation() { prevented++; }});
    assert.equal(prevented, 2);
  }
}
`

func TestNavigationReturnsRemotePageBeforeSendingStop(t *testing.T) {
	for _, action := range []remoteAction{remoteStop, remoteRestart} {
		synctest.Test(t, func(t *testing.T) {
			manager := remoteTestManager(nil)
			manager.setStatus(remoteControlStatus("ready"))
			var order []string
			manager.stdin = &remoteReplyWriter{write: func(data []byte) (int, error) {
				order = append(order, "command")
				return len(data), nil
			}}
			n := &desktopNavigation{manager: manager,
				beforeRemoteStop: func(status backendStatus) {
					if !status.RemoteEnabled || status.DshToken == "" {
						t.Fatal("返回必须发起于 relay 关闭前")
					}
					if _, err := remoteFallbackScript(status); err != nil {
						t.Fatal(err)
					}
					order = append(order, "return")
				},
				open:   func(string, bool) { t.Error("不能无条件打开或控制外部浏览器") },
				report: func(err error) { t.Error(err) },
			}
			defer n.Close()
			n.runRemote(action)
			n.runRemote(action)
			synctest.Wait()
			if strings.Join(order, ",") != "return,command" {
				t.Fatalf("返回/停止顺序不正确或重复：%v", order)
			}
			applyRemoteControlStatus(manager, remoteControlStatus("stopping"))
			if action == remoteStop {
				applyRemoteControlStatus(manager, remoteControlStatus("idle"))
			} else {
				applyRemoteControlStatus(manager, remoteControlStatus("starting"))
				applyRemoteControlStatus(manager, remoteControlStatus("ready"))
			}
			synctest.Wait()
		})
	}
}

func TestNavigationDoesNotReturnPageOnStartOrRejectedStop(t *testing.T) {
	for _, action := range []remoteAction{remoteStart, remoteStop} {
		synctest.Test(t, func(t *testing.T) {
			manager := remoteTestManager(&remoteCommandWriter{})
			manager.setStatus(remoteControlStatus("idle"))
			n := &desktopNavigation{manager: manager,
				beforeRemoteStop: func(backendStatus) { t.Error("启用或拒绝停止不能改变页面") },
				report:           func(error) {},
			}
			defer n.Close()
			n.runRemote(action)
			synctest.Wait()
		})
	}
}
