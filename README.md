# Hirelens

HR screening assistant that runs on your own computer with a completely free stack.

- **LLM:** Groq (free API key)
- **Embeddings:** small local model (runs on your machine, nothing is sent out for indexing)
- **Agent:** LangGraph (with a built-in fallback router)
- **Storage:** one JSON file in `data/`
- **No paid services, no watermarks, no tracking, no external fonts or scripts**

## What it does

1. **Role:** paste a job description. Must-have requirements are extracted.
2. **Candidates:** drop in PDF, DOCX or TXT resumes. Each one is scored against the role.
3. **Evidence-linked scoring:** every strength cites resume line numbers. The server checks each citation against the real text and flags anything it cannot match ("Could not be matched to the resume"). Click a line reference to see the line highlighted in the resume.
4. **Blind screening and bias check:** the switch hides names, schools, study years, gender cues and contact details from both the model and the screen. "Bias check" scores everyone with identity visible and hidden, then shows score and rank changes. It is a signal to look closer, not proof.
5. **Assistant:** ask questions, compare people, shortlist, prepare interview kits and draft invitations. Names and emails are replaced with aliases (Candidate-1) before anything reaches the model. Every email needs your approval.
6. **Interview kit:** tailored questions that probe each candidate's gaps, plus a printable scorecard.
7. **Shortlist:** email invitations (standard or custom text), export CSV, see sent history.

## Setup (about 5 minutes)

1. Install Node.js 20 or newer from https://nodejs.org
2. In this folder run:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and paste your free key from https://console.groq.com/keys into `GROQ_API_KEY=`
4. Start:
   ```
   npm start
   ```
5. Open http://localhost:3000

The first start downloads a ~25 MB embedding model (needs internet once, then cached in `data/models`). If it cannot download, the app still works using a keyword fallback; Settings shows which one is active.

## Sending real emails (optional)

Without SMTP the app runs in simulated mode: emails are logged, not delivered, and labelled "Logged only".
For Gmail, create an App Password at https://myaccount.google.com/apppasswords and set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM` in `.env`.

## Privacy notes

- Data stays in `data/db.json` on your machine. Only the server on 127.0.0.1 can be reached by default. Set `APP_USER` and `APP_PASS` to require a login.
- Emails, phone numbers and links are always masked before text goes to Groq.
- In the standard scoring pass names and schools are kept so the bias check can measure their influence. Turn on blind screening to hide them.
- Redaction is pattern based and best effort. Review resumes with unusual formats.
- Groq's free tier has rate limits. The app waits and retries automatically; large batches take a few minutes.

## Troubleshooting

- "Groq could not use the model": check https://console.groq.com/docs/models and set `GROQ_MODEL` in `.env`.
- Scanned (image-only) PDFs are not supported (no OCR).
- Port busy: set `PORT` in `.env`.

## Development

`npm test` runs the logic tests with a mocked Groq API (no internet or key needed).
Layout: `server/` (API, scoring, agent, redaction, retrieval), `public/` (UI), `tests/`.
