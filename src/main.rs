mod auth;

use clap::Parser;
use std::env;
use serde::{Deserialize, Serialize};
use reqwest::Client;
use std::io::{self, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use colored::*;
use tokio::time::timeout;
use futures_util::StreamExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct CommandProposal {
    command: String,
    explanation: Option<String>,
    summary: Option<String>,
}

#[derive(Parser)]
#[command(name = "th")]
#[command(about = "A command assistant tool")]
struct Args {
    /// Task description
    task: Vec<String>,
}



#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let raw_query = args.task.join(" ").trim().to_string();

    if raw_query.is_empty() {
        eprintln!("Usage: {} <task description>", env::args().next().unwrap_or("th".to_string()));
        std::process::exit(1);
    }

    // Check if we have a valid token, if not, login
    if auth::access().await?.is_none() {
        println!("No valid Copilot token found. Initiating login...");
        let device_auth = auth::authorize().await?;
        println!("Please visit {} and enter code: {}", device_auth.verification_uri, device_auth.user_code);

        let mut poll_interval = (device_auth.interval as u64).max(1);
        loop {
            match auth::poll(&device_auth.device_code).await? {
                auth::PollResult::Complete => {
                    println!("Login successful!");
                    break;
                }
                auth::PollResult::Pending => {}
                auth::PollResult::SlowDown => {
                    poll_interval = (poll_interval * 2).min(60);
                }
                auth::PollResult::Failed(err) => {
                    eprintln!("Login failed: {}", err);
                    std::process::exit(1);
                }
            }
            tokio::time::sleep(Duration::from_secs(poll_interval)).await;
        }
    }

    let mut spinner = Spinner::new("Planning command…".to_string());

    let context = gather_context();
    let messages = build_prompt(&raw_query, &context);

    let proposal = timeout(Duration::from_secs(30), request_command(&messages)).await;

    match proposal {
        Ok(Ok(Some(proposal))) => {
            spinner.stop();
            render_proposal(&proposal);

            if request_approval().await {
                if let Err(e) = execute_command(&proposal.command).await {
                    eprintln!("Command execution failed: {}", e);
                }
            } else {
                println!("{}", "Command execution cancelled.".yellow());
            }
        }
        Ok(Ok(None)) => {
            spinner.stop();
            eprintln!("{}", "No command proposal returned. Please try rephrasing the request.".red());
            std::process::exit(1);
        }
        Ok(Err(e)) => {
            spinner.stop();
            eprintln!("Failed to query API: {}", e);
            std::process::exit(1);
        }
        Err(_) => {
            spinner.stop();
            eprintln!("{}", "API request timed out.".red());
            std::process::exit(1);
        }
    }

    Ok(())
}

fn gather_context() -> String {
    format!("current working directory: {}", env::current_dir().unwrap_or_default().display())
}

fn build_prompt(task: &str, context: &str) -> Vec<Message> {
    let system_message = Message {
        role: "system".to_string(),
        content: "You are a terminal command planner. Given a user request and project context, respond with ONLY a JSON object containing fields: \"command\", \"explanation\", and optionally \"summary\". Do not include any other text, explanations, or formatting. The \"command\" must be a single shell command. Example: {\"command\": \"ls\", \"explanation\": \"Lists files in the current directory\"}. Return \"summary\" only when the command involves multiple steps, non-trivial options, or could surprise the user; otherwise omit it. You must always propose a best-effort command even if information is missing—do not ask follow-up questions. If critical context is unavailable, make a reasonable assumption and mention it in \"explanation\". You cannot execute additional tools yourself; suggest only the command a user should run. If a safe command truly cannot be produced, return JSON with an empty \"command\" and a short explanation.".to_string(),
    };

    let user_message = Message {
        role: "user".to_string(),
        content: format!("Task: {}\n\nContext:\n{}", task, context),
    };

    vec![system_message, user_message]
}

async fn request_command(messages: &[Message]) -> Result<Option<CommandProposal>, Box<dyn std::error::Error>> {
    let client = Client::new();
    let token = auth::access().await?.ok_or("No valid Copilot token. Please run 'th login' first.")?;
    let url = "https://api.githubcopilot.com/chat/completions";

    let payload = serde_json::json!({
        "model": "gpt-4o",
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 180,
        "stream": true
    });

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("Editor-Version", "vscode/1.99.3")
        .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
        .json(&payload)
        .send()
        .await?;

    if response.status().is_success() {
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let text = std::str::from_utf8(&chunk).unwrap_or("");
            buffer.push_str(text);
        }
        if !buffer.is_empty() {
            if let Some(proposal) = parse_streaming_proposal(&buffer) {
                return Ok(Some(proposal));
            }
        }
        Ok(None)
    } else {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        eprintln!("API request failed: {} {}", status, error_text);
        Ok(None)
    }
}

fn parse_streaming_proposal(content: &str) -> Option<CommandProposal> {
    let mut accumulated_content = String::new();
    // Handle SSE format: split by "data: " and parse each JSON
    for line in content.lines() {
        if line.starts_with("data: ") {
            let data = &line[6..]; // Remove "data: "
            if data == "[DONE]" {
                continue;
            }
            if let Ok(json_value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = json_value["choices"][0]["delta"].as_object() {
                    if let Some(content_str) = delta.get("content").and_then(|c| c.as_str()) {
                        accumulated_content.push_str(content_str);
                    }
                }
            }
        }
    }
    // After accumulating, use extract_json to find the JSON in the content
    if !accumulated_content.is_empty() {
        if let Some(json) = extract_json(&accumulated_content) {
            let command = json.get("command")?.as_str()?.trim().to_string();
            let explanation = json.get("explanation").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
            let summary = json.get("summary").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
            if !command.is_empty() {
                Some(CommandProposal { command, explanation, summary })
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    }
}

fn extract_json(content: &str) -> Option<serde_json::Value> {
    let trimmed = content.trim();
    // Try direct parsing first
    if let Ok(json) = serde_json::from_str(trimmed) {
        return Some(json);
    }
    // Try adding } at the end, in case the JSON is truncated
    let with_brace = trimmed.to_string() + "}";
    if let Ok(json) = serde_json::from_str(&with_brace) {
        return Some(json);
    }
    // Fallback to substring extraction
    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                let json_str = &trimmed[start..=end];
                return serde_json::from_str(json_str).ok();
            }
        }
    }
    None
}

struct Spinner {
    running: Arc<Mutex<bool>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Spinner {
    fn new(label: String) -> Self {
        let running = Arc::new(Mutex::new(true));
        let running_clone = running.clone();
        let handle = thread::spawn(move || {
            let frames = vec![':', '⁖', '⁘', '⁛', '⁙', '⁛', '⁘', '⁖'];
            let mut index = 0;
            while *running_clone.lock().unwrap() {
                print!("\r{} {}", format!("{}", frames[index]).yellow(), label);
                io::stdout().flush().unwrap();
                thread::sleep(Duration::from_millis(140));
                index = (index + 1) % frames.len();
            }
        });
        Self { running, handle: Some(handle) }
    }

    fn stop(&mut self) {
        *self.running.lock().unwrap() = false;
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
        print!("\r\x1b[K");
        io::stdout().flush().unwrap();
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        if *self.running.lock().unwrap() {
            *self.running.lock().unwrap() = false;
            if let Some(handle) = self.handle.take() {
                handle.join().unwrap();
            }
            print!("\r\x1b[K");
            io::stdout().flush().unwrap();
        }
    }
}

async fn request_approval() -> bool {
    print!("{} Execute this command? (y/N): ", "  ->".yellow());
    io::stdout().flush().unwrap();
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap();
    input.trim().to_lowercase().starts_with('y')
}

async fn execute_command(command: &str) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(env::current_dir()?)
        .status()?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Command exited with code {:?}", status.code()).into())
    }
}

fn render_proposal(proposal: &CommandProposal) {
    println!("  {} {}", "command:".blue(), proposal.command.green());

    if let Some(explanation) = &proposal.explanation {
        println!("  {} {}", "reason:".blue(), explanation.dimmed());
    }

    if let Some(summary) = &proposal.summary {
        println!("  {} {}", "summary:".blue(), summary.dimmed());
    }

    println!();
}