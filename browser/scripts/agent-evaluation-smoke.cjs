"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const {
  AgentClient,
  createAgentEvaluationProvenance,
  fixtureScenarios,
  MemoryTrace,
  runAgentEvaluation,
  serializeAgentEvaluationReport,
  TraceRecorder,
} = require("../../agent/dist");
const { launchHost, listSockets, stopHost, waitForSocket, dataUrl } = require("./agent-smoke-support.cjs");

const html = `<!doctype html>
<meta charset="utf-8">
<title>Agent evaluation fixture</title>
<style>body{font:16px sans-serif;margin:24px}button,input,select,[role=switch]{display:block;margin:8px 0;padding:8px}[role=switch]{border:1px solid #999;width:160px}</style>
<span id="launch-name">Launch workflow</span>
<button id="launch" aria-label="Wrong name" aria-labelledby="launch-name">Visible button</button>
<label for="agent-name">Name</label><input id="agent-name">
<label for="full-name">Full name</label><input id="full-name" placeholder="Ignored by label" value="" required>
<input id="search" type="search" placeholder="Search records">
<input id="amount" type="number" value="3">
<input id="volume" type="range" min="0" max="10" value="4">
<select id="choices" multiple aria-label="Choices"><option value="a" selected>Alpha</option><option value="b">Beta</option></select>
<div id="notifications" role="switch" aria-checked="false" aria-label="Notifications">Notifications</div>
<button id="pressed" aria-pressed="true">Pressed action</button>
<button id="spaced">  Save <span> now </span> </button>
<button id="continue" aria-label="Continue">Continue</button>
<button id="hidden" hidden>Hidden action</button>
<div aria-hidden="true"><button id="aria-hidden">ARIA hidden action</button></div>
<div inert><button id="inert">Inert action</button></div>
<fieldset disabled><button id="disabled">Disabled action</button></fieldset>
<output id="status">Idle</output>
<script>
  document.getElementById('launch').addEventListener('click', () => document.getElementById('status').textContent = 'Launched');
  document.getElementById('continue').addEventListener('click', () => document.getElementById('status').textContent = 'Ready');
  document.getElementById('notifications').addEventListener('click', event => event.currentTarget.setAttribute('aria-checked', String(event.currentTarget.getAttribute('aria-checked') !== 'true')));
</script>`;

const shadowHtml = `<!doctype html><meta charset="utf-8"><title>Shadow evaluation fixture</title><x-control></x-control><script>customElements.define('x-control',class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:'open'});root.innerHTML='<label>Shadow name <input aria-label="Shadow name"></label><button aria-label="Shadow action">Shadow action</button><span id="status">Idle</span>';root.querySelector('button').addEventListener('click',()=>{root.querySelector('#status').textContent='Clicked';const dynamic=document.createElement('button');dynamic.setAttribute('aria-label','Dynamic action');dynamic.textContent='Dynamic action';root.append(dynamic)})}});</script>`;

const frameChildHtml = `<!doctype html><label>Frame name <input aria-label="Frame name"></label><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;
const frameHtml = `<!doctype html><meta charset="utf-8"><title>Frame evaluation fixture</title><iframe title="Control frame"></iframe><script>document.querySelector('iframe').srcdoc=${JSON.stringify(frameChildHtml)}</script>`;

const crossOriginChildHtml = `<!doctype html><label>Frame name <input aria-label="Frame name"></label><label>Frame choice <select aria-label="Frame choice"><option value="one">One</option><option value="two">Two</option></select></label><label><input type="checkbox" aria-label="Frame enabled">Frame enabled</label><div role="region" aria-label="Frame scroll area" style="height:90px;overflow:auto;border:1px solid #888"><div style="height:400px;padding:8px">Scrollable frame content</div></div><button aria-label="Frame action" onclick="document.querySelector('#status').textContent='Clicked';const b=document.createElement('button');b.setAttribute('aria-label','Frame dynamic');b.textContent='Frame dynamic';document.body.append(b)">Frame action</button><span id="status">Idle</span>`;
const navigationStartHtml = `<!doctype html><meta charset="utf-8"><title>Navigation start</title><button aria-label="Start action">Start action</button><output>Navigation start</output>`;
const navigationNextHtml = `<!doctype html><meta charset="utf-8"><title>Navigation next</title><label>Recovered name <input aria-label="Recovered name"></label><button aria-label="Next action" onclick="document.querySelector('output').textContent='Next clicked'">Next action</button><output>Next ready</output>`;
const eventHtml = `<!doctype html><meta charset="utf-8"><title>Native event fixture</title><button aria-label="Emit console" onclick="console.warn('agent console probe')">Emit console</button><button aria-label="Emit dialog" onclick="alert('agent dialog probe')">Emit dialog</button>`;

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error && error.code === code);
}

function snapshotToken(snapshot) {
  return {
    pageId: snapshot.pageId,
    documentId: snapshot.documentId,
    revision: snapshot.revision,
    snapshotId: snapshot.snapshotId,
  };
}

function semanticScenarios(pageId) {
  return [
    {
      id: "semantic-naming-and-state",
      name: "semantic-naming-and-state",
      async run(client) {
        const snapshot = await client.call("page.snapshot", {
          pageId,
          options: { interactiveOnly: false, includeGeometry: false },
        });
        const byId = (id) => snapshot.nodes.find((node) => node.attributes?.id === id);
        const launch = byId("launch");
        const fullName = byId("full-name");
        const search = byId("search");
        const amount = byId("amount");
        const volume = byId("volume");
        const choices = byId("choices");
        const notifications = byId("notifications");
        const pressed = byId("pressed");
        const spaced = byId("spaced");
        const hidden = byId("hidden");
        const ariaHidden = byId("aria-hidden");
        const inert = byId("inert");
        const disabled = byId("disabled");
        const passed = launch?.role === "button" && launch.name === "Launch workflow"
          && fullName?.role === "textbox" && fullName.name === "Full name"
          && fullName.state?.required === true && fullName.state.invalid === true
          && search?.role === "searchbox" && amount?.role === "spinbutton"
          && volume?.role === "slider" && choices?.role === "listbox"
          && notifications?.role === "switch" && notifications.state?.checked === false
          && pressed?.state?.pressed === true && spaced?.name === "Save now"
          && hidden?.visible === false && hidden.enabled === false
          && ariaHidden?.visible === false && ariaHidden.enabled === false
          && inert?.visible === false && inert.enabled === false
          && disabled?.visible === true && disabled.enabled === false;
        return {
          passed,
          metrics: {
            semanticNodes: snapshot.nodes.length,
            nativeRoleChecks: [search, amount, volume, choices].filter(Boolean).length,
            stateChecks: [fullName, notifications, pressed, hidden, ariaHidden, inert, disabled].filter(Boolean).length,
          },
        };
      },
    },
    {
      id: "semantic-text-normalization",
      name: "semantic-text-normalization",
      async run(client) {
        await client.call("page.wait", { pageId, condition: { type: "text", value: "Save\n now" }, timeoutMs: 3_000 });
        return { passed: true, metrics: { normalizedTextChecks: 1 } };
      },
    },
    {
      id: "semantic-actions-verify-state",
      name: "semantic-actions-verify-state",
      async run(client) {
        const filled = await client.call("page.act", {
          pageId,
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Full name", exact: true } }, value: "Ada" },
        });
        const checked = await client.call("page.act", {
          pageId,
          action: { type: "check", target: { locator: { kind: "role", role: "switch", name: "Notifications", exact: true } }, checked: true },
        });
        const snapshot = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const fullName = snapshot.nodes.find((node) => node.attributes?.id === "full-name");
        const notifications = snapshot.nodes.find((node) => node.attributes?.id === "notifications");
        const passed = filled.verified && filled.proof?.name === "Full name" && filled.proof.value === "Ada"
          && checked.verified && checked.proof?.value === "true"
          && fullName?.state?.value === "Ada" && fullName.state.invalid === undefined
          && notifications?.state?.checked === true;
        return { passed, metrics: { verifiedActions: 2, stateUpdates: passed ? 2 : 0 } };
      },
    },
    {
      id: "semantic-visibility-safety",
      name: "semantic-visibility-safety",
      async run(client) {
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "ARIA hidden action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Inert action", exact: true } } } }), "TARGET_NOT_FOUND");
        await expectCode(client.call("page.act", { pageId, action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Disabled action", exact: true } } } }), "NOT_INTERACTABLE");
        return { passed: true, metrics: { unsafeTargetsRejected: 4 } };
      },
    },
  ];
}

function shadowScenarios(pageId) {
  return [{
    id: "shadow-dom-resolution-and-mutation",
    name: "shadow-dom-resolution-and-mutation",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Shadow action" }, timeoutMs: 3_000 });
      const initial = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const shadowButton = initial.nodes.find((node) => node.name === "Shadow action");
      const shadowTextbox = initial.nodes.find((node) => node.name === "Shadow name");
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Shadow name", exact: true } }, value: "Ada" },
      });
      const typed = await client.call("page.act", { pageId, action: { type: "type", text: " Lovelace" } });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Shadow action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 3_000 },
      });
      const after = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const dynamic = after.nodes.find((node) => node.name === "Dynamic action");
      const passed = shadowButton?.frameId === "main" && shadowTextbox?.frameId === "main"
        && filled.verified && typed.proof?.value === "Ada Lovelace" && clicked.verified && Boolean(dynamic);
      return { passed, metrics: { shadowControls: [shadowButton, shadowTextbox].filter(Boolean).length, shadowMutations: dynamic ? 1 : 0 } };
    },
  }];
}

function frameScenarios(pageId) {
  return [{
    id: "same-origin-frame-resolution-and-mutation",
    name: "same-origin-frame-resolution-and-mutation",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Frame action" }, timeoutMs: 3_000 });
      const initial = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const frameButton = initial.nodes.find((node) => node.name === "Frame action");
      const frameTextbox = initial.nodes.find((node) => node.name === "Frame name");
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } }, value: "Ada" },
      });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 3_000 },
      });
      const after = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const dynamic = after.nodes.find((node) => node.name === "Frame dynamic");
      const passed = Boolean(frameButton?.frameId && frameButton.frameId !== "main")
        && frameTextbox?.frameId === frameButton.frameId && frameButton.box?.width > 0
        && filled.verified && clicked.verified && dynamic?.frameId === frameButton.frameId;
      return { passed, metrics: { frameControls: [frameButton, frameTextbox].filter(Boolean).length, frameMutations: dynamic ? 1 : 0 } };
    },
  }];
}

function crossOriginScenarios(pageId) {
  return [{
    id: "cross-origin-frame-actions-and-replay",
    name: "cross-origin-frame-actions-and-replay",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Frame action" }, timeoutMs: 5_000 });
      const frames = await client.frames(pageId);
      const childFrame = frames.frames.find((frame) => frame.parentFrameId !== null);
      const initial = await client.call("page.snapshot", { pageId, options: { includeGeometry: true } });
      const frameButton = initial.nodes.find((node) => node.name === "Frame action");
      const frameTextbox = initial.nodes.find((node) => node.name === "Frame name");
      const hovered = await client.call("page.act", {
        pageId,
        action: { type: "hover", target: { locator: { kind: "css", value: 'button[aria-label="Frame action"]' } } },
      });
      const scrolled = await client.call("page.act", {
        pageId,
        idempotencyKey: "evaluation-cross-origin-scroll-1",
        action: { type: "scroll", target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } }, direction: "down", amount: 60 },
      });
      const selected = await client.call("page.act", {
        pageId,
        action: { type: "select", target: { locator: { kind: "role", role: "combobox", name: "Frame choice", exact: true } }, values: ["two"] },
      });
      const checked = await client.call("page.act", {
        pageId,
        action: { type: "check", target: { locator: { kind: "role", role: "checkbox", name: "Frame enabled", exact: true } }, checked: true },
      });
      const filled = await client.call("page.act", {
        pageId,
        action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Frame name", exact: true } }, value: "Ada" },
      });
      const typed = await client.call("page.act", { pageId, action: { type: "type", text: " Lovelace" } });
      const clicked = await client.call("page.act", {
        pageId,
        action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Frame action", exact: true } } },
        expect: { text: "Clicked", timeoutMs: 5_000 },
      });
      const retry = await client.call("page.act", {
        pageId,
        idempotencyKey: "evaluation-cross-origin-scroll-1",
        action: { type: "scroll", target: { locator: { kind: "role", role: "region", name: "Frame scroll area", exact: true } }, direction: "down", amount: 60 },
      });
      const mutated = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const dynamic = mutated.nodes.find((node) => node.name === "Frame dynamic");
      const lifecycleEvents = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.event === "frame.lifecycle") lifecycleEvents.push(event);
      });
      try {
        await client.observe(pageId, ["frame.lifecycle"]);
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Navigate frame", exact: true } } },
        });
        const navigatedFrame = await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.find((frame) => frame.parentFrameId !== null && frame.url.endsWith("/frame-next.html"));
        });
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Remove frame", exact: true } } },
        });
        await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.every((frame) => frame.parentFrameId === null) ? tree : undefined;
        });
        await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Add frame", exact: true } } },
        });
        const restoredFrame = await waitFor(async () => {
          const tree = await client.frames(pageId);
          return tree.frames.find((frame) => frame.parentFrameId !== null && frame.url.endsWith("/frame-restored.html"));
        });
        const lifecycleTransitions = lifecycleEvents.filter((event) => ["navigated", "detached", "attached"].includes(event.data?.type));
        const passed = Boolean(childFrame && frameButton?.frameId && frameButton.frameId !== "main")
          && frameTextbox?.frameId === frameButton.frameId && frameButton.box?.width > 0
          && hovered.verified && scrolled.verified && selected.proof?.value === "two"
          && checked.proof?.value === "true" && filled.verified && typed.proof?.value === "Ada Lovelace"
          && clicked.verified && retry.replayed === true && dynamic?.frameId === frameButton.frameId
          && navigatedFrame?.url.endsWith("/frame-next.html") && restoredFrame?.url.endsWith("/frame-restored.html")
          && lifecycleTransitions.length >= 3;
        return {
          passed,
          metrics: {
            crossOriginControls: [frameButton, frameTextbox].filter(Boolean).length,
            verifiedActions: [hovered, scrolled, selected, checked, filled, typed, clicked].filter((action) => action.verified).length,
            replayedActions: retry.replayed === true ? 1 : 0,
            lifecycleTransitions: lifecycleTransitions.length,
          },
        };
      } finally {
        unsubscribe();
      }
    },
  }];
}

function topLevelNavigationScenarios(pageId, urls) {
  return [{
    id: "top-level-navigation-and-stale-recovery",
    name: "top-level-navigation-and-stale-recovery",
    async run(client) {
      await client.call("page.wait", { pageId, condition: { type: "text", value: "Navigation start" }, timeoutMs: 5_000 });
      const start = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
      const lifecycleEvents = [];
      const navigationEvents = [];
      const unsubscribe = client.onEvent((event) => {
        if (event.event === "frame.lifecycle") lifecycleEvents.push(event);
        if (event.event === "navigation") navigationEvents.push(event);
      });
      try {
        await client.observe(pageId, ["frame.lifecycle", "navigation", "load"]);
        const navigated = await client.call("page.act", {
          pageId,
          token: snapshotToken(start),
          action: { type: "navigate", url: urls.next },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(start),
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Start action", exact: true } } },
        }), "STALE_SNAPSHOT");
        const next = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const filled = await client.call("page.act", {
          pageId,
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Recovered name", exact: true } }, value: "Ada" },
        });
        const clicked = await client.call("page.act", {
          pageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Next action", exact: true } } },
          expect: { text: "Next clicked", timeoutMs: 3_000 },
        });
        const reloaded = await client.call("page.act", {
          pageId,
          action: { type: "reload" },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(next),
          action: { type: "fill", target: { locator: { kind: "role", role: "textbox", name: "Recovered name", exact: true } }, value: "stale" },
        }), "STALE_SNAPSHOT");
        const restored = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const back = await client.call("page.act", {
          pageId,
          token: snapshotToken(restored),
          action: { type: "history", direction: "back" },
          expect: { url: "/start.html", title: "Navigation start", text: "Navigation start", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          token: snapshotToken(restored),
          action: { type: "history", direction: "forward" },
        }), "STALE_SNAPSHOT");
        const forward = await client.call("page.act", {
          pageId,
          action: { type: "history", direction: "forward" },
          expect: { url: "/next.html", title: "Navigation next", text: "Next ready", timeoutMs: 5_000 },
        });
        await expectCode(client.call("page.act", {
          pageId,
          action: { type: "history", direction: "forward" },
        }), "HISTORY_UNAVAILABLE");
        const final = await client.call("page.snapshot", { pageId, options: { interactiveOnly: false, includeGeometry: false } });
        const mainNavigations = lifecycleEvents.filter((event) => event.data?.type === "navigated" && event.data.frame?.frameId === "main");
        const passed = navigated.verified && navigated.effects.some((effect) => effect.type === "navigation")
          && filled.verified && clicked.verified
          && reloaded.verified && next.documentId !== restored.documentId
          && back.verified && forward.verified
          && mainNavigations.length >= 4 && navigationEvents.length >= 4
          && final.nodes.some((node) => node.name === "Recovered name");
        return {
          passed,
          metrics: {
            topLevelNavigations: mainNavigations.length,
            navigationEvents: navigationEvents.length,
            staleTokenRejections: 3,
            recoveredControls: final.nodes.filter((node) => node.name === "Recovered name").length,
          },
        };
      } finally {
        unsubscribe();
      }
    },
  }];
}

function tabActivationScenarios(pageId, otherPageId) {
  return [{
    id: "tab-activation-reports-active-page",
    name: "tab-activation-reports-active-page",
    async run(client) {
      const before = await client.call("pages.list", {});
      const target = before.pages.find((page) => page.pageId === pageId);
      const other = before.pages.find((page) => page.pageId === otherPageId);
      if (!target || !other || target.pageId === other.pageId) {
        return { passed: false, reason: "evaluation did not expose two distinct pages", metrics: { pages: before.pages.length } };
      }
      const activated = await client.call("pages.activate", { pageId });
      const after = await client.call("pages.list", {});
      const activeTarget = after.pages.find((page) => page.pageId === pageId);
      const inactiveOther = after.pages.find((page) => page.pageId === otherPageId);
      const restored = await client.call("pages.activate", { pageId: otherPageId });
      const final = await client.call("pages.list", {});
      const inactiveTarget = final.pages.find((page) => page.pageId === pageId);
      const activeOther = final.pages.find((page) => page.pageId === otherPageId);
      const passed = activated.active && restored.active
        && activeTarget?.active === true && inactiveOther?.active === false
        && inactiveTarget?.active === false && activeOther?.active === true;
      return {
        passed,
        metrics: {
          pages: before.pages.length,
          activeReadbacks: Number(activated.active) + Number(restored.active),
        },
      };
    },
  }];
}

function nativeEventScenarios(eventPageId, downloadPageId, failureUrl) {
  return [{
    id: "native-page-events-are-delivered",
    name: "native-page-events-are-delivered",
    async run(client) {
      const events = [];
      let downloadedPath;
      const unsubscribe = client.onEvent((event) => {
        if (["console", "dialog", "download", "page.error"].includes(event.event)) events.push(event);
      });
      try {
        await client.call("page.wait", { pageId: eventPageId, condition: { type: "text", value: "Emit console" }, timeoutMs: 3_000 });
        await client.call("page.wait", { pageId: downloadPageId, condition: { type: "text", value: "Download file" }, timeoutMs: 3_000 });
        await client.observe(eventPageId, ["console", "dialog", "page.error"]);
        await client.observe(downloadPageId, ["download"]);
        await client.call("pages.activate", { pageId: eventPageId });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit console", exact: true } } },
        });
        const consoleEvent = await waitFor(() => events.find(
          (event) => event.event === "console" && event.data?.message === "agent console probe",
        ));
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit dialog", exact: true } } },
        });
        const dialogEvent = await waitFor(() => events.find(
          (event) => event.event === "dialog" && event.data?.message === "agent dialog probe",
        ));
        const dialogCountBeforeNavigation = events.filter((event) => event.event === "dialog").length;
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "navigate", url: dataUrl(eventHtml) },
          expect: { title: "Native event fixture", text: "Emit dialog", timeoutMs: 5_000 },
        });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "button", name: "Emit dialog", exact: true } } },
        });
        const dialogAfterNavigation = await waitFor(() => {
          const dialogs = events.filter((event) => event.event === "dialog");
          return dialogs.length > dialogCountBeforeNavigation ? dialogs[dialogs.length - 1] : undefined;
        });
        await client.call("pages.activate", { pageId: downloadPageId });
        await client.call("page.act", {
          pageId: downloadPageId,
          action: { type: "click", target: { locator: { kind: "role", role: "link", name: "Download file", exact: true } } },
        });
        const downloadEvent = await waitFor(() => events.find(
          (event) => event.event === "download" && event.data?.state === "done",
        ));
        downloadedPath = downloadEvent?.data?.path;
        await client.call("pages.activate", { pageId: eventPageId });
        await client.call("page.act", {
          pageId: eventPageId,
          action: { type: "navigate", url: failureUrl },
          expect: { title: "unreachable", timeoutMs: 500 },
        });
        const errorEvent = await waitFor(() => events.find(
          (event) => event.event === "page.error" && event.data?.kind === "load",
        ));
        const passed = consoleEvent?.data?.level === "warning"
          && dialogEvent?.data?.dialogType === "alert"
          && dialogEvent?.data?.handled === "dismissed"
          && dialogAfterNavigation?.data?.handled === "dismissed"
          && downloadEvent?.data?.filename === "agent-control-download.txt"
          && downloadEvent?.data?.receivedBytes > 0
          && errorEvent?.data?.mainFrame === true
          && errorEvent?.data?.code !== 0;
        return {
          passed,
          metrics: {
            consoleEvents: events.filter((event) => event.event === "console").length,
            dialogEvents: events.filter((event) => event.event === "dialog").length,
            downloadStates: new Set(events.filter((event) => event.event === "download").map((event) => event.data?.state)).size,
            pageErrors: events.filter((event) => event.event === "page.error").length,
          },
        };
      } finally {
        unsubscribe();
        if (typeof downloadedPath === "string") {
          try { fs.unlinkSync(downloadedPath); } catch {}
        }
      }
    },
  }];
}

async function run() {
  const existing = new Set(listSockets());
  const { host, output } = launchHost();
  let childServer;
  let parentServer;
  let client;
  let pageId;
  let shadowPageId;
  let framePageId;
  let crossOriginPageId;
  let navigationPageId;
  let eventPageId;
  let downloadPageId;
  let navigationServer;
  let downloadServer;
  let failurePort;
  try {
    childServer = await serve(crossOriginChildHtml);
    parentServer = await serve(`<!doctype html><meta charset="utf-8"><title>Cross-origin evaluation fixture</title><button aria-label="Navigate frame" onclick="document.querySelector('iframe').src='http://127.0.0.1:${childServer.port}/frame-next.html'">Navigate frame</button><button aria-label="Remove frame" onclick="document.querySelector('iframe').remove()">Remove frame</button><button aria-label="Add frame" onclick="const frame=document.createElement('iframe');frame.title='Control frame';frame.src='http://127.0.0.1:${childServer.port}/frame-restored.html';document.body.append(frame)">Add frame</button><iframe title="Control frame" src="http://127.0.0.1:${childServer.port}/frame.html"></iframe>`);
    navigationServer = await serveRoutes({ "/start.html": navigationStartHtml, "/next.html": navigationNextHtml });
    downloadServer = await serveDownload();
    failurePort = await closedPort();
    const socket = await waitForSocket(existing, 15_000, output);
    const trace = new MemoryTrace();
    client = await AgentClient.connect(socket, {
      clientId: "evaluation-smoke",
      trace: new TraceRecorder(trace),
    });
    const hello = await client.hello();
    const opened = await client.call("pages.open", { url: dataUrl(html) });
    pageId = opened.pageId;
    shadowPageId = (await client.call("pages.open", { url: dataUrl(shadowHtml) })).pageId;
    framePageId = (await client.call("pages.open", { url: dataUrl(frameHtml) })).pageId;
    crossOriginPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${parentServer.port}/index.html` })).pageId;
    navigationPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${navigationServer.port}/start.html` })).pageId;
    eventPageId = (await client.call("pages.open", { url: dataUrl(eventHtml) })).pageId;
    downloadPageId = (await client.call("pages.open", { url: `http://127.0.0.1:${downloadServer.port}/index.html` })).pageId;
    await client.call("page.wait", { pageId, condition: { type: "text", value: "Continue" }, timeoutMs: 3_000 });
    const scenarios = [
      ...fixtureScenarios(pageId),
      ...semanticScenarios(pageId),
      ...shadowScenarios(shadowPageId),
      ...frameScenarios(framePageId),
      ...crossOriginScenarios(crossOriginPageId),
      ...topLevelNavigationScenarios(navigationPageId, {
        next: `http://127.0.0.1:${navigationServer.port}/next.html`,
      }),
      ...tabActivationScenarios(pageId, navigationPageId),
      ...nativeEventScenarios(eventPageId, downloadPageId, `http://127.0.0.1:${failurePort}/unreachable.html`),
    ];
    const report = await runAgentEvaluation(client, scenarios, {
      trace,
      includeTrace: process.env.TERMINAL_BROWSER_EVALUATION_TRACE === "1",
      provenance: createAgentEvaluationProvenance(),
    });
    const artifactPath = process.env.TERMINAL_BROWSER_EVALUATION_ARTIFACT;
    if (artifactPath) fs.writeFileSync(artifactPath, serializeAgentEvaluationReport(report), "utf8");
    assert.equal(report.failed, 0, JSON.stringify(report));
    assert.equal(report.passRate, 1);
    assert.ok(report.metrics.traceRequests > 0);
    assert.ok(report.metrics.traceResponses > 0);
    assert.ok(report.metrics.traceEvents > 0);
    assert.ok(report.cases.every((entry) => entry.trace && entry.trace.entries > 0));
    console.log(JSON.stringify({
      contract: report.contract,
      version: report.version,
      protocol: `${hello.protocol}/${hello.version}`,
      passRate: report.passRate,
      metrics: report.metrics,
      cases: report.cases.map(({ id, passed, durationMs, trace: window, metrics }) => ({ id, passed, durationMs, trace: window, metrics })),
    }));
  } finally {
    if (client) {
      if (pageId) await client.call("pages.close", { pageId }).catch(() => {});
      if (shadowPageId) await client.call("pages.close", { pageId: shadowPageId }).catch(() => {});
      if (framePageId) await client.call("pages.close", { pageId: framePageId }).catch(() => {});
      if (crossOriginPageId) await client.call("pages.close", { pageId: crossOriginPageId }).catch(() => {});
      if (navigationPageId) await client.call("pages.close", { pageId: navigationPageId }).catch(() => {});
      if (eventPageId) await client.call("pages.close", { pageId: eventPageId }).catch(() => {});
      if (downloadPageId) await client.call("pages.close", { pageId: downloadPageId }).catch(() => {});
      await client.close().catch(() => {});
    }
    stopHost(host);
    if (parentServer) await closeServer(parentServer);
    if (childServer) await closeServer(childServer);
    if (navigationServer) await closeServer(navigationServer);
    if (downloadServer) await closeServer(downloadServer);
  }
}

function serve(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function serveRoutes(routes) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const body = routes[pathname];
    if (body === undefined) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function serveDownload() {
  const body = Buffer.from("agent download payload\n", "utf8");
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/index.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><a href="/agent-control-download.txt">Download file</a>');
      return;
    }
    if (pathname === "/agent-control-download.txt") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="agent-control-download.txt"',
        "content-length": body.length,
      });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({ server, port: server.address().port });
    });
  });
}

function closedPort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function closeServer(entry) {
  return new Promise((resolve) => entry.server.close(() => resolve()));
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for evaluation state");
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
