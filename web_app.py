import argparse
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

from dotenv import load_dotenv

from youtube_scraper.chatbot import answer_with_llm
from youtube_scraper.search import is_overview_question, print_video_overview, semantic_search


ROOT_DIR = Path(__file__).resolve().parent
load_dotenv(ROOT_DIR / ".env")
load_dotenv(ROOT_DIR / "youtube_scraper" / ".env")

LOCAL_DIR = ROOT_DIR / "local"
LOCAL_DIR.mkdir(exist_ok=True)
TEMPLATE_DIR = ROOT_DIR / "templates"
STATIC_DIR = ROOT_DIR / "static"


JOBS = {}
JOBS_LOCK = threading.Lock()


def safe_slug(value):
    value = value.strip()
    match = re.search(r"(?:v=|youtu\.be/|shorts/)([a-zA-Z0-9_-]{6,})", value)
    if match:
        value = match.group(1)
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.replace("đ", "d").replace("Đ", "D")
    value = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-").lower()
    return value[:48] or f"video-{int(time.time())}"


def fetch_youtube_title(video_url):
    """Fetch a public YouTube title for naming local dataset folders."""
    try:
        encoded_url = quote(video_url, safe="")
        oembed_url = f"https://www.youtube.com/oembed?url={encoded_url}&format=json"
        req = urllib.request.Request(oembed_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return (payload.get("title") or "").strip()
    except Exception:
        return ""


def json_response(handler, payload, status=200):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, socket.timeout):
        return



def file_response(handler, path, content_type):
    try:
        body = path.read_bytes()
        handler.send_response(200)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
    except FileNotFoundError:
        json_response(handler, {"error": "Asset not found"}, 404)
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, socket.timeout):
        return


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length).decode("utf-8")
    return json.loads(raw or "{}")


def output_paths(output_file):
    output = Path(output_file)
    base = output.with_suffix("")
    return {
        "json": str(output),
        "rag": str(base) + "_rag.jsonl",
        "index": str(base) + "_vector_index.faiss",
        "embeddings": str(base) + "_embeddings.npy",
    }


def create_job(video_url, output_name, delay, transcribe_missing=False):
    job_id = uuid.uuid4().hex[:12]
    title = output_name.strip() if output_name else fetch_youtube_title(video_url)
    dataset_slug = safe_slug(title or video_url)
    dataset_dir = LOCAL_DIR / dataset_slug
    dataset_dir.mkdir(parents=True, exist_ok=True)
    output_file = str(dataset_dir / f"{dataset_slug}.json")
    command = [
        sys.executable,
        "-m",
        "youtube_scraper.main",
        "--video",
        video_url,
        "--output",
        output_file,
        "--langs",
        "vi-orig,vi,vi-VN",
        "--delay",
        str(delay),
        "--rag",
        "--knowledge-base",
    ]

    if transcribe_missing:
        command.append("--transcribe-missing")

    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "status": "running",
            "command": " ".join(command),
            "output_file": output_file,
            "log": [],
            "started_at": time.time(),
            "finished_at": None,
            "returncode": None,
        }

    thread = threading.Thread(target=run_job, args=(job_id, command), daemon=True)
    thread.start()
    return JOBS[job_id]


def append_job_log(job_id, line):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job:
            job["log"].append(line.rstrip())
            job["log"] = job["log"][-500:]


def run_job(job_id, command):
    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        process = subprocess.Popen(
            command,
            cwd=str(ROOT_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )

        assert process.stdout is not None
        for line in process.stdout:
            append_job_log(job_id, line)

        returncode = process.wait()
        with JOBS_LOCK:
            job = JOBS[job_id]
            job["returncode"] = returncode
            job["finished_at"] = time.time()
            job["status"] = "completed" if returncode == 0 else "failed"
    except Exception as exc:
        append_job_log(job_id, f"ERROR: {exc}")
        with JOBS_LOCK:
            job = JOBS[job_id]
            job["status"] = "failed"
            job["finished_at"] = time.time()
            job["returncode"] = -1


def list_datasets():
    datasets = []
    json_files = list(LOCAL_DIR.glob("*.json")) + list(LOCAL_DIR.glob("*/*.json"))
    json_files = sorted(json_files, key=lambda p: p.stat().st_mtime, reverse=True)

    for json_file in json_files:
        paths = output_paths(str(json_file))
        title = json_file.stem
        display_name = str(json_file.relative_to(LOCAL_DIR))

        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            videos = data.get("videos", [])
            if videos:
                video = videos[0]
                title = video.get("title") or title
                language = video.get("transcript_language") or "-"
                channel = video.get("channel_title") or ""
                url = video.get("url") or ""
                thumbnail = video.get("thumbnail_url") or ""
                duration = video.get("duration") or "-"
                words = len((video.get("transcript") or "").split())
            else:
                language = "-"
                channel = ""
                url = ""
                thumbnail = ""
                duration = "-"
                words = 0
        except Exception:
            language = "-"
            channel = ""
            url = ""
            thumbnail = ""
            duration = "-"
            words = 0
            pass

        chunk_count = 0
        try:
            with open(paths["rag"], "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        chunk_count += 1
        except Exception:
            chunk_count = 0

        datasets.append(
            {
                "file": str(json_file),
                "name": display_name,
                "title": title,
                "channel": channel,
                "url": url,
                "thumbnail": thumbnail,
                "duration": duration,
                "language": language,
                "chunks": chunk_count,
                "words": words,
                "has_rag": Path(paths["rag"]).exists(),
                "has_index": Path(paths["index"]).exists(),
            }
        )
    return datasets


def answer_question(output_file, question, use_llm):
    paths = output_paths(output_file)
    if is_overview_question(question) and not use_llm:
        return {
            "mode": "overview",
            "answer": build_metadata_overview(output_file),
            "sources": [],
        }

    if use_llm:
        answer = answer_with_llm(
            question=question,
            output_file=output_file,
            index_file=paths["index"],
            rag_file=paths["rag"],
            top_k=3,
        )
        return {"mode": "llm", "answer": answer, "sources": []}

    results = semantic_search(question, paths["index"], paths["rag"], top_k=3)
    return {
        "mode": "search",
        "answer": "",
        "sources": [
            {
                "rank": item.get("rank"),
                "title": item.get("title"),
                "time": f"{item.get('start_time', '')} - {item.get('end_time', '')}",
                "url": item.get("url_with_timestamp"),
                "text": item.get("text", "")[:900],
                "score": item.get("score"),
                "rerank_score": item.get("rerank_score"),
            }
            for item in results
        ],
    }


def build_metadata_overview(output_file):
    try:
        data = json.loads(Path(output_file).read_text(encoding="utf-8"))
        video = (data.get("videos") or [{}])[0]
    except Exception:
        return "Không đọc được file dữ liệu video."

    parts = [
        f"Tiêu đề: {video.get('title', '')}",
        f"Kênh: {video.get('channel_title', '')}",
        f"Thời lượng: {video.get('duration', '')}",
        f"Link: {video.get('url', '')}",
    ]

    description = (video.get("description") or "").split("---------------------------------")[0].strip()
    if description:
        parts.append("\nMô tả:\n" + description[:1200])

    transcript = (video.get("transcript") or "").strip()
    if transcript:
        parts.append("\nMở đầu transcript:\n" + transcript[:900] + "...")
    return "\n".join(parts)



class AppHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/":
            file_response(self, TEMPLATE_DIR / "index.html", "text/html; charset=utf-8")
            return

        if parsed.path == "/static/app.css":
            file_response(self, STATIC_DIR / "app.css", "text/css; charset=utf-8")
            return

        if parsed.path == "/static/app.js":
            file_response(self, STATIC_DIR / "app.js", "application/javascript; charset=utf-8")
            return

        if parsed.path == "/api/datasets":
            json_response(self, {"datasets": list_datasets()})
            return

        if parsed.path.startswith("/api/jobs/"):
            job_id = parsed.path.rsplit("/", 1)[-1]
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                payload = dict(job) if job else None
            if not payload:
                json_response(self, {"error": "Job not found"}, 404)
                return
            json_response(self, payload)
            return

        json_response(self, {"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/jobs":
                payload = read_json_body(self)
                video_url = (payload.get("video_url") or "").strip()
                if not video_url:
                    json_response(self, {"error": "Missing video_url"}, 400)
                    return
                job = create_job(
                    video_url=video_url,
                    output_name=payload.get("output_name") or "",
                    delay=int(payload.get("delay") or 15),
                    transcribe_missing=bool(payload.get("transcribe_missing")),
                )
                json_response(self, job, 201)
                return

            if parsed.path == "/api/ask":
                payload = read_json_body(self)
                output_file = payload.get("output_file") or ""
                question = (payload.get("question") or "").strip()
                use_llm = bool(payload.get("use_llm"))
                if not output_file or not question:
                    json_response(self, {"error": "Missing output_file or question"}, 400)
                    return
                if not Path(output_file).exists():
                    json_response(self, {"error": "Dataset not found"}, 404)
                    return
                json_response(self, answer_question(output_file, question, use_llm))
                return

            json_response(self, {"error": "Not found"}, 404)
        except Exception as exc:
            json_response(self, {"error": str(exc)}, 500)

    def log_message(self, format, *args):
        return


def main():
    parser = argparse.ArgumentParser(description="Local web UI for YouTube RAG.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), AppHandler)
    print(f"Web app running at http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
