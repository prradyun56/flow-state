"use client";

import { useState, useEffect, useCallback } from "react";

type Tab = { url: string; title: string; pinned: boolean };
type Session = {
  session_id: string;
  name: string;
  created_at: string;
  tabs: Tab[];
  terminal_commands: string[];
  working_directory: string;
  git_branch: string;
  notes: string;
};

const DEFAULT_SERVER = "http://localhost:8080";

function timeAgo(dateStr: string) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s / 31536000 > 1) return Math.floor(s / 31536000) + "Y AGO";
  if (s / 86400 > 1) return Math.floor(s / 86400) + "D AGO";
  if (s / 3600 > 1) return Math.floor(s / 3600) + "H AGO";
  if (s / 60 > 1) return Math.floor(s / 60) + "M AGO";
  return "JUST NOW";
}

function shortenPath(p: string) {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState(DEFAULT_SERVER);
  const [serverInput, setServerInput] = useState(DEFAULT_SERVER);
  const [selected, setSelected] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  const showToast = (msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${server}/sessions`);
      if (!res.ok) throw new Error(`SERVER ERROR ${res.status}`);
      const data = await res.json();
      setSessions(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "COULD NOT REACH SYNC SERVER");
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const deleteSession = async (name: string) => {
    setDeleting(name);
    try {
      await fetch(`${server}/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
      showToast(`DELETED "${name}"`, "success");
      fetchSessions();
      if (selected?.name === name) setSelected(null);
    } catch {
      showToast("DELETE FAILED", "error");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="min-h-screen font-mono text-sm tracking-widest text-[#f0f0f0] p-4 lg:p-8 flex flex-col gap-6">
      
      {/* Nav */}
      <nav className="glass-panel rounded-sm flex items-center justify-between px-6 py-4 uppercase text-xs z-10 transition-colors">
        <div className="flex items-center gap-4">
          <span className="text-[#00e5ff] font-bold text-lg tracking-[0.2em] drop-shadow-[0_0_10px_rgba(0,229,255,0.4)]">FLOWSTATE</span>
          <span className="text-[#888] hidden md:block">TEAM SYNC DASHBOARD</span>
        </div>
        <div className="flex items-center gap-3">
          <input
            value={serverInput}
            onChange={e => setServerInput(e.target.value)}
            placeholder="SERVER URL"
            className="bg-[#0f0f0f80] border border-[#ffffff1a] text-[#f0f0f0] px-3 py-2 outline-none focus:border-[#00e5ff] transition-all rounded-[2px]"
            onKeyDown={e => { if (e.key === "Enter") { setServer(serverInput.trim()); } }}
          />
          <button 
            onClick={() => setServer(serverInput.trim())} 
            className="border border-[#00e5ff80] text-[#00e5ff] px-4 py-2 hover:bg-[#00e5ff] hover:text-[#050505] transition-all font-bold rounded-[2px] shadow-[0_0_15px_rgba(0,229,255,0.1)]"
          >
            CONNECT
          </button>
          <button 
            onClick={fetchSessions} 
            className="border border-[#ffffff1a] text-[#888] px-3 py-2 hover:text-[#f0f0f0] hover:border-[#ffffff50] transition-all rounded-[2px]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </nav>

      {/* Main Grid Layout */}
      <div className="flex gap-6 flex-col md:flex-row flex-1 overflow-hidden z-10">
        
        {/* Sidebar — session list */}
        <aside className="glass-panel rounded-sm w-full md:w-80 overflow-y-auto flex flex-col p-4">
          <div className="mb-4 text-[10px] text-[#888] uppercase tracking-[0.1em] border-b border-[#ffffff1a] pb-2">
            {sessions.length} SESSION{sessions.length !== 1 ? "S" : ""} ON {server}
          </div>

          {loading && <div className="text-[#888] text-xs text-center py-10 animate-pulse">LOADING LOGS...</div>}
          {error  && <div className="text-[#ff3366] text-xs text-center py-10 drop-shadow-[0_0_8px_rgba(255,51,102,0.4)]">{error}</div>}

          {!loading && !error && sessions.length === 0 && (
            <div className="text-[#888] text-xs text-center py-10 leading-loose">
              NO SESSIONS FOUND.<br />PUSH ONE VIA CLI:<br />
              <code className="text-[#00e5ff] bg-[#00000030] px-2 py-1 mt-2 inline-block border border-[#00e5ff30]">flowstate push &lt;name&gt;</code>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {sessions.map((s, i) => (
              <div
                key={s.session_id}
                onClick={() => setSelected(s)}
                className={`fade-up cursor-pointer bg-[#0f0f0f80] border p-3 rounded-[2px] transition-all hover-glow ${
                  selected?.session_id === s.session_id ? "border-[#00e5ff] shadow-[0_0_15px_rgba(0,229,255,0.2)]" : "border-[#ffffff1a]"
                }`}
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="font-bold text-sm mb-1 uppercase tracking-wider">{s.name}</div>
                <div className="text-[9px] text-[#888] flex flex-wrap gap-2 uppercase tracking-[0.1em]">
                  <span className="text-[10px]">❏ {s.tabs.length} TAB{s.tabs.length !== 1 ? "S" : ""}</span>
                  {s.git_branch && <span className="text-[#ffaa00] drop-shadow-[0_0_5px_rgba(255,170,0,0.3)]">⎇ {s.git_branch}</span>}
                  <span className="ml-auto">{timeAgo(s.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Main — detail panel */}
        <main className="glass-panel rounded-sm flex-1 overflow-y-auto p-6 md:p-10 relative">
          {!selected ? (
            <div className="flex flex-col items-center justify-center h-full gap-6 opacity-50">
              <div className="text-6xl text-[#ffffff1a]">◈</div>
              <div className="text-[#888] text-xs text-center leading-loose uppercase tracking-[0.2em]">
                AWAITING SIGNAL...<br />
                SELECT A SESSION TO INSPECT LOGS
              </div>
            </div>
          ) : (
            <div className="fade-up relative z-10 w-full max-w-4xl mx-auto">
              
              {/* Header */}
              <div className="flex justify-between items-start mb-10 pb-6 border-b border-[#ffffff1a]">
                <div>
                  <h1 className="text-2xl font-bold uppercase tracking-[0.15em] drop-shadow-[0_0_10px_rgba(255,255,255,0.2)]">{selected.name}</h1>
                  <div className="mt-2 text-[10px] text-[#888] uppercase tracking-[0.1em]">
                    LOGGED: {new Date(selected.created_at).toLocaleString()} · {timeAgo(selected.created_at)}
                  </div>
                </div>
                <button 
                  onClick={() => deleteSession(selected.name)} 
                  className={`border border-[#ff336680] text-[#ff3366] px-4 py-2 text-xs font-bold hover:bg-[#ff3366] hover:text-[#050505] transition-all rounded-[2px] shadow-[0_0_15px_rgba(255,51,102,0.1)] ${deleting === selected.name ? 'opacity-50' : ''}`}
                >
                  {deleting === selected.name ? "PURGING..." : "✕ PURGE"}
                </button>
              </div>

              {/* Meta badges */}
              <div className="flex gap-3 mb-8 flex-wrap">
                {selected.git_branch && <Badge color="#ffaa00">⎇ {selected.git_branch}</Badge>}
                {selected.working_directory && <Badge color="#888">📁 {shortenPath(selected.working_directory)}</Badge>}
                <Badge color="#00e5ff">❏ {selected.tabs.length} TABS</Badge>
              </div>

              {selected.notes && (
                <div className="bg-[#0f0f0f80] border-l-2 border-[#ff3366] p-4 mb-8 text-xs text-[#aaa] uppercase tracking-wider italic">
                  "{selected.notes}"
                </div>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
                
                {/* Tabs Area */}
                <Section title={`BROWSER_TABS_DUMP (${selected.tabs.length})`}>
                  {selected.tabs.length === 0 ? (
                    <div className="text-[#777] text-[10px] uppercase">NO TABS CAPTURED IN THIS SNAPSHOT.</div>
                  ) : (
                    <div className="flex flex-col max-h-[400px] overflow-y-auto pr-2">
                      {selected.tabs.map((t, i) => (
                        <a key={i} href={t.url} target="_blank" rel="noreferrer" className="flex items-center gap-4 py-3 border-b border-[#ffffff1a] hover:bg-[#ffffff05] transition-colors p-2 -mx-2">
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${new URL(t.url).hostname}&sz=16`}
                            width={16} height={16}
                            alt=""
                            className="shrink-0 rounded-[2px] opacity-80"
                            onError={e => (e.currentTarget.style.display = "none")}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-[#e0e0e0] truncate uppercase">{t.title || t.url}</div>
                            <div className="text-[10px] text-[#00e5ff] truncate opacity-70 mt-1">{t.url}</div>
                          </div>
                          {t.pinned && <span className="text-[10px] text-[#ff3366] drop-shadow-[0_0_5px_rgba(255,51,102,0.4)] ml-auto">📌 PIN</span>}
                        </a>
                      ))}
                    </div>
                  )}
                </Section>

                {/* Terminal Area */}
                <Section title={`TTY_HISTORY_DUMP (${Math.min(selected.terminal_commands.length, 20)})`}>
                  {selected.terminal_commands.length === 0 ? (
                    <div className="text-[#777] text-[10px] uppercase">NO TERMINAL LOGS.</div>
                  ) : (
                    <div className="bg-[#050505] border border-[#ffffff1a] rounded-[2px] p-4 h-[400px] overflow-y-auto">
                      {/* Fake window buttons matching cyberpunk vibe - simple squares */}
                      <div className="flex gap-2 mb-4 opacity-50 border-b border-[#ffffff1a] pb-2">
                        <div className="w-2 h-2 bg-[#ff3366]"></div>
                        <div className="w-2 h-2 bg-[#ffaa00]"></div>
                        <div className="w-2 h-2 bg-[#00e5ff]"></div>
                      </div>
                      <div className="text-[#00e5ff] text-xs leading-loose glow-text select-text">
                        {selected.terminal_commands.slice(-20).map((cmd, i) => (
                          <div key={i} className="mb-1 uppercase tracking-wide">
                            <span className="text-[#888] select-none">$ </span>{cmd}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Section>
              </div>

              {/* Pull Instructions */}
              <div className="mt-8 bg-[#0f0f0f80] border border-[#ffffff1a] rounded-[2px] p-5 flex items-center justify-between">
                <div className="text-[10px] text-[#888] uppercase tracking-[0.1em]">
                  RESTORE THIS SNAPSHOT LOCALLY:
                </div>
                <code className="text-[#ffaa00] text-sm font-bold bg-[#00000030] px-3 py-1 border border-[#ffaa0030] drop-shadow-[0_0_8px_rgba(255,170,0,0.2)]">
                  flowstate pull {selected.name}
                </code>
              </div>

            </div>
          )}
        </main>
      </div>

      {/* Toast popup */}
      {toast && (
        <div className={`fixed bottom-8 left-1/2 transform -translate-x-1/2 px-6 py-3 rounded-[2px] text-xs font-bold tracking-widest uppercase z-50 backdrop-blur-md transition-all fade-up
          ${toast.type === "success" 
            ? "border border-[#00e5ff] bg-[#00e5ff1a] text-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.3)]" 
            : "border border-[#ff3366] bg-[#ff33661a] text-[#ff3366] shadow-[0_0_20px_rgba(255,51,102,0.3)]"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Badge({ color, children }: { color: string; children: React.ReactNode }) {
  // Parsing dynamic color to tailwind inline styles for borders/shadows
  return (
    <span 
      style={{ 
        backgroundColor: `${color}15`, 
        borderColor: `${color}40`, 
        color, 
        textShadow: `0 0 5px ${color}50` 
      }} 
      className="border px-3 py-1 text-[10px] uppercase font-bold tracking-[0.1em] rounded-[2px]"
    >
      {children}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0f0f0f50] border border-[#ffffff1a] p-5 rounded-[2px]">
      <div className="text-[10px] text-[#888] uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
        <span className="w-2 h-2 bg-[#ff3366] inline-block opacity-70"></span> {title}
      </div>
      {children}
    </div>
  );
}
