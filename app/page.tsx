/* app/page.tsx */
"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";

/* =========================
   TYPES
========================= */

type PlayerStats = {
  name: string;
  drinks: number;
  cardsDrawn: number;
};

type PowerType = "HEAVEN" | "THUMB";

type ActiveCall = {
  id: string;
  type: PowerType;
  by: string;
  endsAt: number; // ms epoch
  taps: Record<string, number>; // id -> tapTime(ms epoch)
};

type ActiveRule = {
  id: string;
  name: string;
  by: string;
  createdAt: number;
};

type GameState = {
  host: string | null;
  deck: string[];
  currentCard: string | null;
  players: Record<string, PlayerStats>;

  powers: {
    heavenHolder: string | null; // 7
    thumbHolder: string | null; // J
    questionMaster: string | null; // Q
    ruleMaster: string | null; // K
  };

  cooldowns: {
    heavenReadyAt: number;
    thumbReadyAt: number;
  };

  activeCall: ActiveCall | null;

  matesOut: Record<string, string[]>; // from -> [to...]
  activeRules: ActiveRule[];
};

type Layout = "l1" | "l2" | "l3" | "l4" | "l5" | "l6";

type Msg =
  | { type: "STATE"; data: GameState }
  | { type: "DRAW" }
  | { type: "DRINK_REQ"; by: string; target: string; delta: number; reason: string }
  | { type: "SET_MATE_REQ"; by: string; to: string }
  | { type: "CALL_START_REQ"; callType: PowerType; by: string }
  | { type: "CALL_TAP"; callId: string; by: string; t: number }
  | { type: "QM_GOTCHA_REQ"; by: string; target: string }
  | { type: "RULE_ADD_REQ"; by: string; name: string }
  | { type: "RULE_CLEAR_REQ"; by: string; ruleId: string };

/* =========================
   HELPERS
========================= */

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const d: string[] = [];
  for (const r of ranks) for (const s of suits) d.push(`${r}${s}`);
  return d;
}

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function encode(obj: any) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function decode(buf: Uint8Array) {
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
}

function rankOf(card: string | null): string | null {
  if (!card) return null;
  const suit = card.slice(-1);
  const r = card.slice(0, card.length - suit.length);
  return r || null;
}

function computeVideoLayout(count: number): Layout {
  if (count <= 1) return "l1";
  if (count === 2) return "l2";
  if (count === 3) return "l3";
  if (count === 4) return "l4";
  if (count === 5) return "l5";
  return "l6";
}

function nowMs() {
  return Date.now();
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

/* =========================
   RULE PRESETS (NO TYPING)
========================= */

const RULE_PRESETS: { label: string; value: string }[] = [
  { label: "No swearing 🤐", value: "No swearing 🤐" },
  { label: "Drink with left hand ✋", value: "Drink with left hand ✋" },
  { label: "No saying 'drink' 🚫🍺", value: "No saying 'drink' 🚫🍺" },
  { label: "No phones 📵", value: "No phones 📵" },
  { label: "Anyone says 'Kyle' = +1 🍺", value: "Anyone says 'Kyle' = +1 🍺" },
  { label: "Everyone cheers before drinking 🥂", value: "Everyone cheers before drinking 🥂" },
  { label: "No first names only nicknames 😈", value: "No first names only nicknames 😈" },
  { label: "Last to laugh drinks 😂", value: "Last to laugh drinks 😂" },
];

/* =========================
   MAIN APP
========================= */

export default function Page() {
  const roomRef = useRef<Room | null>(null);
  const me = useRef<string>("");
  const videoRef = useRef<HTMLDivElement>(null);

  const callTimerRef = useRef<number | null>(null);

  const [roomCode, setRoomCode] = useState("kad");
  const [name, setName] = useState("");

  const [connected, setConnected] = useState(false);
  const [joining, setJoining] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");

  const [pickMode, setPickMode] = useState<null | { kind: "MATE" | "QM"; by: string }>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [state, setState] = useState<GameState>({
    host: null,
    deck: [],
    currentCard: null,
    players: {},
    powers: { heavenHolder: null, thumbHolder: null, questionMaster: null, ruleMaster: null },
    cooldowns: { heavenReadyAt: 0, thumbReadyAt: 0 },
    activeCall: null,
    matesOut: {},
    activeRules: [],
  });

  const stateRef = useRef<GameState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /* =========================
     FULLSCREEN
  ========================= */

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e: any) {
      setErrMsg(`Fullscreen failed: ${e?.message || e}`);
    }
  }

  /* =========================
     VIDEO HANDLING
  ========================= */

  function ensureTile(id: string) {
    const root = videoRef.current;
    if (!root) return null;

    let el = root.querySelector(`[data-id="${CSS.escape(id)}"]`) as HTMLDivElement | null;

    if (!el) {
      el = document.createElement("div");
      el.className = "vTile";
      el.dataset.id = id;

      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.muted = id === me.current;

      const tag = document.createElement("div");
      tag.className = "vTag";
      tag.innerText = id;

      const meta = document.createElement("div");
      meta.className = "vMeta";
      meta.innerText = "";

      el.append(v, tag, meta);
      root.append(el);
    }

    return el;
  }

  function removeTile(id: string) {
    const root = videoRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) el.remove();
  }

  function reorderTiles(order: string[]) {
    const root = videoRef.current;
    if (!root) return;

    const map = new Map<string, HTMLElement>();
    Array.from(root.querySelectorAll(".vTile")).forEach((el) => {
      const id = (el as HTMLElement).dataset.id || "";
      if (id) map.set(id, el as HTMLElement);
    });

    for (const id of order) {
      const el = map.get(id);
      if (el) root.appendChild(el);
    }
  }

  async function attachLocalTracks(room: Room) {
    room.localParticipant.videoTrackPublications.forEach((pub) => {
      const track = pub.track;
      if (!track) return;
      const tile = ensureTile(me.current);
      if (!tile) return;
      if (track.kind === Track.Kind.Video) track.attach(tile.querySelector("video")!);
    });
  }

  /* =========================
     NETWORK
  ========================= */

  async function send(msg: Msg) {
    const r = roomRef.current;
    if (!r) return;
    await r.localParticipant.publishData(encode(msg), { reliable: true });
  }

  function ensurePlayer(gs: GameState, id: string) {
    if (!gs.players[id]) gs.players[id] = { name: id, drinks: 0, cardsDrawn: 0 };
  }

  function addMate(gs: GameState, from: string, to: string) {
    if (!from || !to || from === to) return;
    if (!gs.matesOut[from]) gs.matesOut[from] = [];
    if (!gs.matesOut[from].includes(to)) gs.matesOut[from].push(to);
  }

  function applyDrinkWithMates(gs: GameState, startId: string, delta: number) {
    const visited = new Set<string>();
    const queue: string[] = [];

    const push = (id: string) => {
      if (!id) return;
      if (visited.has(id)) return;
      visited.add(id);
      queue.push(id);
    };

    push(startId);

    while (queue.length) {
      const id = queue.shift()!;
      ensurePlayer(gs, id);
      gs.players[id].drinks = Math.max(0, gs.players[id].drinks + delta);

      const outs = gs.matesOut[id] || [];
      for (const to of outs) push(to);
    }
  }

  function scheduleResolveIfHost(next: GameState) {
    if (!next.activeCall) return;
    if (next.host !== me.current) return;

    const delay = Math.max(0, next.activeCall.endsAt - nowMs());
    if (callTimerRef.current) {
      window.clearTimeout(callTimerRef.current);
      callTimerRef.current = null;
    }

    callTimerRef.current = window.setTimeout(() => {
      const cur = stateRef.current;
      if (!cur.activeCall) return;
      if (cur.host !== me.current) return;
      resolveCallAsHost(cur);
    }, delay + 25);
  }

  function resolveCallAsHost(gs: GameState) {
    const next = clone(gs);
    const call = next.activeCall;
    if (!call) return;

    const roster = Object.keys(next.players).filter(Boolean);
    if (!roster.length) {
      next.activeCall = null;
      setState(next);
      send({ type: "STATE", data: next });
      return;
    }

    let loser = roster[0];
    let worst = -1;

    for (const id of roster) {
      const t = call.taps[id];
      const val = typeof t === "number" ? t : Number.POSITIVE_INFINITY;
      if (val > worst) {
        worst = val;
        loser = id;
      }
    }

    applyDrinkWithMates(next, loser, 1);

    const readyAt = nowMs() + 15_000;
    if (call.type === "HEAVEN") next.cooldowns.heavenReadyAt = readyAt;
    if (call.type === "THUMB") next.cooldowns.thumbReadyAt = readyAt;

    next.activeCall = null;

    setState(next);
    send({ type: "STATE", data: next });
  }

  /* =========================
     GAME ACTIONS
  ========================= */

  async function draw() {
    const cur = stateRef.current;
    if (!roomRef.current) return;

    if (cur.host !== me.current) {
      await send({ type: "DRAW" });
      return;
    }

    const next = clone(cur);

    if (!next.deck.length) next.deck = shuffle(buildDeck());

    const card = next.deck.shift() || null;
    next.currentCard = card;

    ensurePlayer(next, me.current);
    next.players[me.current].cardsDrawn++;

    const r = rankOf(card);

    if (r === "7") {
      next.powers.heavenHolder = me.current;
    } else if (r === "J") {
      next.powers.thumbHolder = me.current;
    } else if (r === "Q") {
      next.powers.questionMaster = me.current;
    } else if (r === "K") {
      next.powers.ruleMaster = me.current;
      // open rules modal locally for the drawer
      setRulesOpen(true);
    } else if (r === "8") {
      setPickMode({ kind: "MATE", by: me.current });
    } else if (r === "3") {
      applyDrinkWithMates(next, me.current, 1);
    } else if (r === "6") {
      for (const id of Object.keys(next.players)) {
        ensurePlayer(next, id);
        next.players[id].drinks = Math.max(0, next.players[id].drinks + 1);
      }
    }

    setState(next);
    await send({ type: "STATE", data: next });
  }

  async function requestDrink(delta: number, reason: string) {
    const cur = stateRef.current;
    if (!roomRef.current) return;
    if (!me.current) return;
    if (!cur.host) return;
    await send({ type: "DRINK_REQ", by: me.current, target: me.current, delta, reason });
  }

  async function startCall(type: PowerType) {
    if (!roomRef.current) return;
    if (!me.current) return;
    await send({ type: "CALL_START_REQ", callType: type, by: me.current });
  }

  async function tapCall() {
    const cur = stateRef.current;
    if (!roomRef.current) return;
    if (!me.current) return;
    if (!cur.activeCall) return;

    await send({ type: "CALL_TAP", callId: cur.activeCall.id, by: me.current, t: nowMs() });
  }

  async function qmGotchaStart() {
    const cur = stateRef.current;
    if (cur.powers.questionMaster !== me.current) return;
    setPickMode({ kind: "QM", by: me.current });
  }

  async function onPickTarget(targetId: string) {
    const cur = stateRef.current;
    if (!pickMode) return;

    if (pickMode.kind === "MATE") {
      await send({ type: "SET_MATE_REQ", by: pickMode.by, to: targetId });
      setPickMode(null);
      return;
    }

    if (pickMode.kind === "QM") {
      await send({ type: "QM_GOTCHA_REQ", by: pickMode.by, target: targetId });
      setPickMode(null);
      return;
    }
  }

  async function addRule(ruleName: string) {
    const cur = stateRef.current;
    if (!roomRef.current) return;
    if (!me.current) return;
    if (!cur.host) return;

    // Only the current rule master should add rules (keeps it clean)
    if (cur.powers.ruleMaster !== me.current) return;

    await send({ type: "RULE_ADD_REQ", by: me.current, name: ruleName });
    setRulesOpen(false);
  }

  async function clearRule(ruleId: string) {
    const cur = stateRef.current;
    if (!roomRef.current) return;
    if (!me.current) return;
    if (!cur.host) return;

    // Only host OR rule master can clear
    const allowed = cur.host === me.current || cur.powers.ruleMaster === me.current;
    if (!allowed) return;

    await send({ type: "RULE_CLEAR_REQ", by: me.current, ruleId });
  }

  /* =========================
     CONNECT / DISCONNECT
  ========================= */

  async function connect() {
    setErrMsg("");

    const roomName = roomCode.trim();
    const identity = name.trim();

    if (!roomName || !identity) {
      setErrMsg("Enter a room + name.");
      return;
    }

    setJoining(true);

    try {
      const res = await fetch(`/api/token?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(identity)}`);
      const data = await res.json();

      if (!res.ok) throw new Error(data?.error || `Token API failed (${res.status})`);
      if (!data?.token || !data?.url) throw new Error("Token API returned missing token/url.");

      const room = new Room();
      roomRef.current = room;
      me.current = identity;

      ensureTile(identity);

      room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          return n;
        });

        const tile = ensureTile(participant.identity);
        if (!tile) return;
        if (track.kind === Track.Kind.Video) track.attach(tile.querySelector("video")!);
      });

      room.on(RoomEvent.ParticipantConnected, (participant) => {
        setState((s) => {
          const n = clone(s);
          ensurePlayer(n, participant.identity);
          return n;
        });
        ensureTile(participant.identity);
      });

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        removeTile(participant.identity);
        setState((s) => {
          const n = clone(s);
          if (n.players[participant.identity]) delete n.players[participant.identity];
          return n;
        });
      });

      room.on(RoomEvent.DataReceived, (buf) => {
        const msg = decode(buf);
        if (!msg) return;

        const cur = stateRef.current;
        const isHost = cur.host === me.current;

        if (msg.type === "STATE") {
          setState(msg.data);
          scheduleResolveIfHost(msg.data);
          return;
        }

        if (msg.type === "DRAW") {
          if (isHost) draw();
          return;
        }

        if (msg.type === "DRINK_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          ensurePlayer(next, msg.target);
          applyDrinkWithMates(next, msg.target, msg.delta);
          setState(next);
          send({ type: "STATE", data: next });
          return;
        }

        if (msg.type === "SET_MATE_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          ensurePlayer(next, msg.by);
          ensurePlayer(next, msg.to);
          addMate(next, msg.by, msg.to);
          setState(next);
          send({ type: "STATE", data: next });
          return;
        }

        if (msg.type === "QM_GOTCHA_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          ensurePlayer(next, msg.target);
          applyDrinkWithMates(next, msg.target, 1);
          setState(next);
          send({ type: "STATE", data: next });
          return;
        }

        if (msg.type === "RULE_ADD_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          const rule: ActiveRule = {
            id: uid("rule"),
            name: msg.name,
            by: msg.by,
            createdAt: nowMs(),
          };
          next.activeRules = [rule, ...next.activeRules].slice(0, 12);
          setState(next);
          send({ type: "STATE", data: next });
          return;
        }

        if (msg.type === "RULE_CLEAR_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          next.activeRules = next.activeRules.filter((r: ActiveRule) => r.id !== msg.ruleId);
          setState(next);
          send({ type: "STATE", data: next });
          return;
        }

        if (msg.type === "CALL_START_REQ") {
          if (!isHost) return;
          const next = clone(cur);
          if (next.activeCall) return;

          const t = nowMs();

          if (msg.callType === "HEAVEN") {
            if (next.powers.heavenHolder !== msg.by) return;
            if (t < (next.cooldowns.heavenReadyAt || 0)) return;
          }
          if (msg.callType === "THUMB") {
            if (next.powers.thumbHolder !== msg.by) return;
            if (t < (next.cooldowns.thumbReadyAt || 0)) return;
          }

          next.activeCall = {
            id: uid("call"),
            type: msg.callType,
            by: msg.by,
            endsAt: t + 2600,
            taps: {},
          };

          setState(next);
          send({ type: "STATE", data: next });
          scheduleResolveIfHost(next);
          return;
        }

        if (msg.type === "CALL_TAP") {
          if (!isHost) return;
          const next = clone(cur);
          if (!next.activeCall) return;
          if (next.activeCall.id !== msg.callId) return;

          if (next.activeCall.taps[msg.by] == null) {
            next.activeCall.taps[msg.by] = msg.t;
            setState(next);
            send({ type: "STATE", data: next });
          }
          return;
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        setConnected(false);
      });

      await room.connect(data.url, data.token);

      setConnected(true);

      const current = stateRef.current;
      const next = clone(current);
      ensurePlayer(next, identity);

      if (!next.host) {
        next.host = identity;
        next.deck = shuffle(buildDeck());
      }

      setState(next);
      await send({ type: "STATE", data: next });

      try {
        await room.localParticipant.setCameraEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        await attachLocalTracks(room);
      } catch (e: any) {
        setErrMsg(`Camera/mic blocked: ${e?.message || e}`);
      }
    } catch (e: any) {
      setErrMsg(e?.message || String(e));
      setConnected(false);
      if (roomRef.current) {
        try {
          roomRef.current.disconnect();
        } catch {}
      }
      roomRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  function disconnect() {
    setErrMsg("");
    const r = roomRef.current;
    if (r) {
      try {
        r.disconnect();
      } catch {}
    }
    roomRef.current = null;

    if (videoRef.current) videoRef.current.innerHTML = "";

    if (callTimerRef.current) {
      window.clearTimeout(callTimerRef.current);
      callTimerRef.current = null;
    }

    setPickMode(null);
    setRulesOpen(false);

    setState({
      host: null,
      deck: [],
      currentCard: null,
      players: {},
      powers: { heavenHolder: null, thumbHolder: null, questionMaster: null, ruleMaster: null },
      cooldowns: { heavenReadyAt: 0, thumbReadyAt: 0 },
      activeCall: null,
      matesOut: {},
      activeRules: [],
    });

    setConnected(false);
  }

  /* =========================
     ORDERING / LAYOUT
  ========================= */

  const orderedPlayers = useMemo(() => {
    const mine = me.current ? [me.current] : [];
    const others = Object.keys(state.players)
      .filter((id) => id && id !== me.current)
      .sort((a, b) => a.localeCompare(b));
    return [...mine, ...others].slice(0, 6);
  }, [state.players]);

  useEffect(() => {
    if (!connected) return;
    reorderTiles(orderedPlayers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, orderedPlayers.join("|")]);

  const effectiveCount = Math.min(6, Math.max(1, orderedPlayers.length || 1));
  const layout = computeVideoLayout(effectiveCount);

  /* =========================
     TILE META (powers + mates)
  ========================= */

  const powerBadges = useMemo(() => {
    const badges: Record<string, string[]> = {};
    const push = (id: string | null, label: string) => {
      if (!id) return;
      if (!badges[id]) badges[id] = [];
      badges[id].push(label);
    };
    push(state.powers.heavenHolder, "☁️");
    push(state.powers.thumbHolder, "👍");
    push(state.powers.questionMaster, "❓");
    push(state.powers.ruleMaster, "👑");
    return badges;
  }, [state.powers]);

  useEffect(() => {
    const root = videoRef.current;
    if (!root) return;

    const tiles = Array.from(root.querySelectorAll(".vTile")) as HTMLDivElement[];
    for (const tile of tiles) {
      const id = tile.dataset.id || "";
      const meta = tile.querySelector(".vMeta") as HTMLDivElement | null;
      if (!meta) continue;

      const badges = powerBadges[id] || [];
      const outs = state.matesOut[id] || [];

      const badgeStr = badges.length ? badges.join(" ") : "";
      const mateStr = outs.length ? `→ ${outs.join(", ")}` : "";

      meta.innerText = [badgeStr, mateStr].filter(Boolean).join("  ");
    }
  }, [powerBadges, state.matesOut, connected]);

  /* =========================
     UI DERIVED
  ========================= */

  const r = rankOf(state.currentCard);
  const isHost = state.host === me.current;

  const heavenReadyIn = Math.max(0, state.cooldowns.heavenReadyAt - nowMs());
  const thumbReadyIn = Math.max(0, state.cooldowns.thumbReadyAt - nowMs());

  const canHeaven = connected && state.powers.heavenHolder === me.current && !state.activeCall && heavenReadyIn === 0;
  const canThumb = connected && state.powers.thumbHolder === me.current && !state.activeCall && thumbReadyIn === 0;
  const canQM = connected && state.powers.questionMaster === me.current && !state.activeCall;
  const canRule = connected && state.powers.ruleMaster === me.current && !state.activeCall;

  const showOverlayCall = connected && !!state.activeCall;
  const overlayTitle = state.activeCall?.type === "HEAVEN" ? "HEAVEN CALLED ☁️" : "THUMB CALLED 👍";
  const overlayLocked = !!state.activeCall && state.activeCall.taps[me.current] != null;

  const deckLeft = state.deck.length;

  const pickHint =
    pickMode?.kind === "MATE"
      ? "Tap a player tile to add as your mate (one-way)"
      : pickMode?.kind === "QM"
      ? "Tap the player who answered (GOTCHA)"
      : "";

  /* =========================
     RENDER
  ========================= */

  return (
    <div className="appB">
      <div className="topbarB">
        <div className="brandB">
          <div className="logoB">KAD</div>
          <div className="titleOnlyB">KAD-KINGS</div>
        </div>

        <div className="topActionsB">
          <button className="iconBtnB" onClick={toggleFullscreen} title="Fullscreen">
            ⤢
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="cardB joinCardB">
          <div className="fieldB">
            <div>Room</div>
            <input value={roomCode} onChange={(e) => setRoomCode(e.target.value)} placeholder="kad" />
          </div>

          <div className="fieldB">
            <div>Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Wes" />
          </div>

          <div className="rowB">
            <button className="btnB btnPrimaryB" onClick={connect} disabled={joining}>
              {joining ? "Joining..." : "Join"}
            </button>
          </div>

          {errMsg ? <div className="noteB errB">{errMsg}</div> : <div className="noteB">Join, then open the same room on another phone to test sync.</div>}
        </div>
      ) : (
        <div className="shellB">
          <div className="cardB videoCardB">
            <div className="cardHeadB">
              <h2>Players</h2>
              <div className="rowB" style={{ justifyContent: "flex-end" }}>
                <div className="tinyPillB">Host: {state.host || "—"}</div>
                <button className="btnB btnDangerB btnTinyB" onClick={disconnect}>
                  Leave
                </button>
              </div>
            </div>

            {errMsg ? <div className="noteB errB">{errMsg}</div> : null}
            {pickMode ? <div className="pickHintB">{pickHint}</div> : null}

            <div
              ref={videoRef}
              className={"videoGridB" + (pickMode ? " pickingB" : "")}
              data-layout={layout}
              onClick={(e) => {
                if (!pickMode) return;
                const target = (e.target as HTMLElement).closest(".vTile") as HTMLDivElement | null;
                if (!target) return;
                const id = target.dataset.id || "";
                if (!id) return;
                if (pickMode.kind === "MATE" && id === pickMode.by) return;
                onPickTarget(id);
              }}
            />
          </div>

          <div className="bottomBarB">
            <div className="cardB deckMiniB">
              <button className="drawComboB" onClick={draw}>
                <div className="cardSquareB">
                  <div className="miniCardB">
                    <div className="miniCornerB">{state.currentCard ? state.currentCard : "—"}</div>
                    <div className="miniRankB">{r || "—"}</div>
                  </div>
                </div>

                <div className="drawTextB">
                  <div className="drawTitleB">{state.currentCard ? "CURRENT CARD" : "DRAW CARD"}</div>
                  <div className="drawSubB">
                    {isHost ? "Tap to draw" : "Tap to request draw"} · Deck: {deckLeft}
                  </div>
                </div>

                <div className="drawMetaB">
                  <div className="metaPillB">{isHost ? "HOST" : "GUEST"}</div>
                  <div className="metaPillB">🃏 {deckLeft}</div>
                </div>
              </button>

              <div className="powerRowB">
                <button className={"powerBtnB" + (canHeaven ? " onB" : "")} disabled={!canHeaven} onClick={() => startCall("HEAVEN")} title="Heaven (7)">
                  ☁️ {state.powers.heavenHolder === me.current ? (heavenReadyIn ? `${Math.ceil(heavenReadyIn / 1000)}s` : "HEAVEN") : "HEAVEN"}
                </button>

                <button className={"powerBtnB" + (canThumb ? " onB" : "")} disabled={!canThumb} onClick={() => startCall("THUMB")} title="Thumbmaster (J)">
                  👍 {state.powers.thumbHolder === me.current ? (thumbReadyIn ? `${Math.ceil(thumbReadyIn / 1000)}s` : "THUMB") : "THUMB"}
                </button>

                <button className={"powerBtnB" + (canQM ? " onB" : "")} disabled={!canQM} onClick={qmGotchaStart} title="Question Master (Q)">
                  ❓ {state.powers.questionMaster === me.current ? "GOTCHA" : "QM"}
                </button>

                <button className={"powerBtnB" + (canRule ? " onB" : "")} disabled={!canRule} onClick={() => setRulesOpen(true)} title="Rule Master (K)">
                  👑 {state.powers.ruleMaster === me.current ? "RULE" : "K"}
                </button>
              </div>
            </div>

            <div className="cardB statsMiniB">
              <div className="yourDrinksRowB">
                <div>
                  <div className="labelMiniB">Your drinks</div>
                  <div className="drinkNumB">{state.players[me.current]?.drinks ?? 0}</div>
                </div>
                <div className="btnGroupB">
                  <button className="btnB btnTinyB" onClick={() => requestDrink(-1, "manual")}>
                    -1
                  </button>
                  <button className="btnB btnPrimaryB btnTinyB" onClick={() => requestDrink(1, "manual")}>
                    +1
                  </button>
                </div>
              </div>

              {state.activeRules.length ? (
                <div className="rulesBoxB">
                  <div className="rulesHeadB">
                    <div className="rulesTitleB">Active rules</div>
                    <div className="rulesHintB">{state.powers.ruleMaster === me.current || state.host === me.current ? "Tap × to remove" : ""}</div>
                  </div>
                  <div className="rulesListB">
                    {state.activeRules.map((rule) => (
                      <div key={rule.id} className="ruleRowB">
                        <div className="ruleTextB">{rule.name}</div>
                        {(state.powers.ruleMaster === me.current || state.host === me.current) ? (
                          <button className="ruleXBtnB" onClick={() => clearRule(rule.id)} title="Remove rule">
                            ×
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="playersMiniListB">
                {orderedPlayers.map((id) => {
                  const p = state.players[id];
                  if (!p) return null;
                  const outs = state.matesOut[id] || [];
                  return (
                    <div key={p.name} className="pRowB">
                      <div className="pNameB">
                        {p.name}
                        {powerBadges[id]?.length ? <span className="pBadgesB"> {powerBadges[id].join(" ")}</span> : null}
                      </div>
                      <div className="pMetaB">
                        🍺 {p.drinks} · 🃏 {p.cardsDrawn}
                        {outs.length ? <span className="pMateB"> · → {outs.join(", ")}</span> : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {showOverlayCall ? (
            <div className="overlayB">
              <div className="overlayCardB">
                <div className="overlayTitleB">{overlayTitle}</div>
                <div className="overlaySubB">Tap fast. Last to tap drinks.</div>

                <button className={"overlayTapB" + (overlayLocked ? " lockedB" : "")} onClick={tapCall} disabled={overlayLocked}>
                  {overlayLocked ? "LOCKED" : "TAP"}
                </button>

                <div className="overlayTimerB">
                  Ends in {Math.max(0, Math.ceil(((state.activeCall?.endsAt || 0) - nowMs()) / 1000))}s
                </div>
              </div>
            </div>
          ) : null}

          {rulesOpen ? (
            <div className="overlayB" onClick={() => setRulesOpen(false)}>
              <div className="rulesModalB" onClick={(e) => e.stopPropagation()}>
                <div className="rulesModalTopB">
                  <div className="rulesModalTitleB">👑 Make a rule</div>
                  <button className="ruleXBtnB" onClick={() => setRulesOpen(false)} title="Close">
                    ×
                  </button>
                </div>
                <div className="rulesGridB">
                  {RULE_PRESETS.map((r) => (
                    <button key={r.value} className="rulePickBtnB" onClick={() => addRule(r.value)}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <div className="rulesModalNoteB">Rules stay active until removed.</div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
         }
