package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
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

func init() {
	rand.Seed(time.Now().UnixNano())
}

func generateUUID() string {
	b := make([]byte, 16)
	for i := range b {
		b[i] = byte(rand.Intn(256))
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func getSessionsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Printf("Error getting home directory: %v\n", err)
		os.Exit(1)
	}
	dir := filepath.Join(home, ".flowstate", "sessions")
	os.MkdirAll(dir, 0755)
	return dir
}

func getHistory() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return []string{}
	}
	
	files := []string{
		filepath.Join(home, ".bash_history"),
		filepath.Join(home, ".zsh_history"),
	}

	for _, file := range files {
		content, err := os.ReadFile(file)
		if err == nil {
			lines := strings.Split(string(content), "\n")
			var valid []string
			for _, l := range lines {
				l = strings.TrimSpace(l)
				if l != "" {
					idx := strings.Index(l, ";")
					if strings.HasPrefix(l, ":") && idx != -1 {
						valid = append(valid, l[idx+1:])
					} else {
						valid = append(valid, l)
					}
				}
			}
			if len(valid) > 10 {
				return valid[len(valid)-10:]
			}
			return valid
		}
	}
	return []string{}
}

func openURL(url string) error {
	var cmd string
	var args []string

	switch runtime.GOOS {
	case "windows":
		cmd = "cmd"
		args = []string{"/c", "start", url}
	case "darwin":
		cmd = "open"
		args = []string{url}
	default: // "linux", "freebsd", "openbsd", "netbsd"
		cmd = "xdg-open"
		args = []string{url}
	}
	return exec.Command(cmd, args...).Start()
}

func findSessionByName(name string) (*Session, string) {
	dir := getSessionsDir()
	files, _ := os.ReadDir(dir)
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, f.Name())
		b, err := os.ReadFile(path)
		if err == nil {
			var s Session
			json.Unmarshal(b, &s)
			if s.Name == name {
				return &s, path
			}
		}
	}
	return nil, ""
}

func cmdSave(args []string) {
	if len(args) < 1 {
		fmt.Println("Error: missing session name")
		fmt.Println("Usage: flowstate save <session-name> [--notes \"optional note\"]")
		os.Exit(1)
	}
	name := args[0]
	notes := ""
	for i := 1; i < len(args); i++ {
		if args[i] == "--notes" && i+1 < len(args) {
			notes = args[i+1]
			break
		}
	}

	sessionID := generateUUID()
	cwd, err := os.Getwd()
	if err != nil {
		cwd = ""
	}
	
	gitCmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	gitCmd.Dir = cwd
	gitOut, err := gitCmd.Output()
	branch := ""
	if err == nil {
		branch = strings.TrimSpace(string(gitOut))
	}

	history := getHistory()
	if history == nil {
		history = []string{}
	}

	session := Session{
		SessionID:        sessionID,
		Name:             name,
		CreatedAt:        time.Now().Format(time.RFC3339),
		Tabs:             []Tab{}, // Explicitly empty, as Chrome extension manages tabs
		TerminalCommands: history,
		WorkingDirectory: cwd,
		GitBranch:        branch,
		Notes:            notes,
	}

	b, _ := json.MarshalIndent(session, "", "  ")

	dir := getSessionsDir()
	path := filepath.Join(dir, sessionID+".json")
	if err := os.WriteFile(path, b, 0644); err != nil {
		fmt.Printf("Error writing session file: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("saved session %q ✓\n", name)
}

func cmdList() {
	dir := getSessionsDir()
	files, err := os.ReadDir(dir)
	if err != nil || len(files) == 0 {
		return
	}
	
	count := 0
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, f.Name())
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var s Session
		if err := json.Unmarshal(b, &s); err != nil {
			continue
		}
		
		t, err := time.Parse(time.RFC3339, s.CreatedAt)
		timeAgo := "just now"
		if err == nil {
			duration := time.Since(t)
			if duration.Hours() > 24 {
				timeAgo = fmt.Sprintf("%d days ago", int(duration.Hours()/24))
			} else if duration.Hours() >= 1 {
				timeAgo = fmt.Sprintf("%d hours ago", int(duration.Hours()))
			} else if duration.Minutes() >= 1 {
				timeAgo = fmt.Sprintf("%d mins ago", int(duration.Minutes()))
			} else {
				seconds := int(duration.Seconds())
				if seconds > 0 {
					timeAgo = fmt.Sprintf("%d secs ago", seconds)
				}
			}
		}

		branch := s.GitBranch
		if branch == "" {
			branch = "no branch"
		}
		fmt.Printf("%s | %d tabs | %s | %s\n", s.Name, len(s.Tabs), branch, timeAgo)
		count++
	}
	
	if count == 0 {
		fmt.Println("No sessions found.")
	}
}

func cmdRestore(args []string) {
	if len(args) < 1 {
		fmt.Println("Error: missing session name")
		fmt.Println("Usage: flowstate restore <session-name>")
		os.Exit(1)
	}
	name := args[0]
	s, _ := findSessionByName(name)
	if s == nil {
		fmt.Printf("Error: session %q not found\n", name)
		os.Exit(1)
	}
	
	for _, tab := range s.Tabs {
		err := openURL(tab.URL)
		if err != nil {
			fmt.Printf("Error opening URL %s: %v\n", tab.URL, err)
		}
	}
	fmt.Printf("restored %q — %d tabs opened\n", name, len(s.Tabs))
}

func cmdDelete(args []string) {
	if len(args) < 1 {
		fmt.Println("Error: missing session name")
		fmt.Println("Usage: flowstate delete <session-name>")
		os.Exit(1)
	}
	name := args[0]
	s, path := findSessionByName(name)
	if s == nil {
		fmt.Printf("Error: session %q not found\n", name)
		os.Exit(1)
	}
	if err := os.Remove(path); err != nil {
		fmt.Printf("Error deleting session file: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("deleted %q ✓\n", name)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: flowstate <command> [arguments]")
		fmt.Println("Commands:")
		fmt.Println("  save <session-name> [--notes \"optional note\"]")
		fmt.Println("  list")
		fmt.Println("  restore <session-name>")
		fmt.Println("  delete <session-name>")
		os.Exit(1)
	}

	command := os.Args[1]
	args := os.Args[2:]

	switch command {
	case "save":
		cmdSave(args)
	case "list":
		cmdList()
	case "restore":
		cmdRestore(args)
	case "delete":
		cmdDelete(args)
	default:
		fmt.Printf("Unknown command %q\n", command)
		os.Exit(1)
	}
}
