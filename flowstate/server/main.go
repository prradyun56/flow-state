package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Tab struct {
	URL    string `json:"url"`
	Title  string `json:"title"`
	Pinned bool   `json:"pinned"`
}

type Session struct {
	SessionID        string   `json:"session_id"`
	Name             string   `json:"name"`
	CreatedAt        string   `json:"created_at"`
	Tabs             []Tab    `json:"tabs"`
	TerminalCommands []string `json:"terminal_commands"`
	WorkingDirectory string   `json:"working_directory"`
	GitBranch        string   `json:"git_branch"`
	Notes            string   `json:"notes"`
}

var db *sql.DB

func initDB() {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".flowstate")
	os.MkdirAll(dir, 0755)
	var err error
	db, err = sql.Open("sqlite", filepath.Join(dir, "server.db"))
	if err != nil {
		log.Fatal(err)
	}
	db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		session_id        TEXT PRIMARY KEY,
		name              TEXT NOT NULL,
		created_at        TEXT NOT NULL,
		tabs              TEXT NOT NULL DEFAULT '[]',
		terminal_commands TEXT NOT NULL DEFAULT '[]',
		working_directory TEXT NOT NULL DEFAULT '',
		git_branch        TEXT NOT NULL DEFAULT '',
		notes             TEXT NOT NULL DEFAULT ''
	)`)
}

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func jsonResponse(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func rowToSession(rows *sql.Rows) Session {
	var s Session
	var tabsJSON, cmdsJSON string
	rows.Scan(&s.SessionID, &s.Name, &s.CreatedAt, &tabsJSON, &cmdsJSON, &s.WorkingDirectory, &s.GitBranch, &s.Notes)
	json.Unmarshal([]byte(tabsJSON), &s.Tabs)
	json.Unmarshal([]byte(cmdsJSON), &s.TerminalCommands)
	if s.Tabs == nil {
		s.Tabs = []Tab{}
	}
	if s.TerminalCommands == nil {
		s.TerminalCommands = []string{}
	}
	return s
}

func handleSessions(w http.ResponseWriter, r *http.Request) {
	// GET /sessions
	if r.Method == http.MethodGet {
		rows, err := db.Query(`SELECT session_id, name, created_at, tabs, terminal_commands, working_directory, git_branch, notes FROM sessions ORDER BY created_at DESC`)
		if err != nil {
			jsonResponse(w, 500, map[string]string{"error": err.Error()})
			return
		}
		defer rows.Close()
		var sessions []Session
		for rows.Next() {
			sessions = append(sessions, rowToSession(rows))
		}
		if sessions == nil {
			sessions = []Session{}
		}
		jsonResponse(w, 200, sessions)
		return
	}

	// POST /sessions
	if r.Method == http.MethodPost {
		var s Session
		if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
			jsonResponse(w, 400, map[string]string{"error": "invalid JSON"})
			return
		}
		if s.SessionID == "" {
			s.SessionID = fmt.Sprintf("%d", time.Now().UnixNano())
		}
		if s.CreatedAt == "" {
			s.CreatedAt = time.Now().Format(time.RFC3339)
		}
		tabsJSON, _ := json.Marshal(s.Tabs)
		cmdsJSON, _ := json.Marshal(s.TerminalCommands)
		_, err := db.Exec(`INSERT OR REPLACE INTO sessions
			(session_id, name, created_at, tabs, terminal_commands, working_directory, git_branch, notes)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			s.SessionID, s.Name, s.CreatedAt, string(tabsJSON), string(cmdsJSON),
			s.WorkingDirectory, s.GitBranch, s.Notes,
		)
		if err != nil {
			jsonResponse(w, 500, map[string]string{"error": err.Error()})
			return
		}
		log.Printf("stored session: %s (%s)", s.Name, s.SessionID)
		jsonResponse(w, 201, s)
		return
	}

	jsonResponse(w, 405, map[string]string{"error": "method not allowed"})
}

func handleSession(w http.ResponseWriter, r *http.Request) {
	// extract name from URL: /sessions/<name>
	name := strings.TrimPrefix(r.URL.Path, "/sessions/")
	if name == "" {
		jsonResponse(w, 400, map[string]string{"error": "missing session name"})
		return
	}

	// GET /sessions/<name>
	if r.Method == http.MethodGet {
		rows, err := db.Query(`SELECT session_id, name, created_at, tabs, terminal_commands, working_directory, git_branch, notes FROM sessions WHERE name = ?`, name)
		if err != nil || !rows.Next() {
			jsonResponse(w, 404, map[string]string{"error": "not found"})
			return
		}
		defer rows.Close()
		s := rowToSession(rows)
		jsonResponse(w, 200, s)
		return
	}

	// DELETE /sessions/<name>
	if r.Method == http.MethodDelete {
		db.Exec(`DELETE FROM sessions WHERE name = ?`, name)
		jsonResponse(w, 200, map[string]string{"ok": "deleted"})
		return
	}

	jsonResponse(w, 405, map[string]string{"error": "method not allowed"})
}

func main() {
	initDB()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/sessions", cors(handleSessions))
	mux.HandleFunc("/sessions/", cors(handleSession))
	mux.HandleFunc("/health", cors(func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, 200, map[string]string{"status": "ok"})
	}))

	log.Printf("FlowState sync server running on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
