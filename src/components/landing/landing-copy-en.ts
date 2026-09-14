import type { LandingCopy } from "./landing-i18n";

/** Landing copy — English. */
export const LANDING_COPY_EN: LandingCopy = {
  nav: { login: "Sign in", signup: "Try it free" },
  hero: {
    badge: "REAL-TIME INTERVIEW ASSISTANT FOR CANDIDATES",
    titleTop: "Walk into interviews",
    titleBottom: "with confidence",
    sub: "Describe your upcoming interview — when the interviewer asks a question, AI suggests an answer right next to the transcript.",
    ctaPrimary: "Try it free",
    ctaSecondary: "Sign in",
    note: "3 free interviews · no card required · Vietnamese – Japanese – English",
  },
  stats: [
    { value: "3", label: "free interviews, no card required" },
    { value: "Realtime", label: "hints appear the moment a question lands" },
    { value: "3", label: "languages: Vietnamese · Japanese · English" },
    { value: "90 days", label: "auto-deleted data, under your control" },
  ],
  features: {
    kicker: "HOW INTERVIEW HACK HELPS YOU",
    heading: "Answer hints the moment you are asked",
    sub: "Describe your upcoming interview — when the interviewer asks a question, a clear answer hint appears right next to the transcript.",
    features: [
      {
        title: "Your brief as context",
        body: "A few lines about the role, company and topics is all it takes — every hint stays specific to your interview, never generic.",
      },
      {
        title: "Clear answer hints",
        body: "The moment a question lands, AI drafts a short, natural-sounding answer — skim it, then say it your own way.",
      },
      {
        title: "Bilingual transcript to review",
        body: "Missed a line in Japanese or English? The transcript translates in real time during the session and stays afterwards for review.",
      },
    ],
    flow: ["Describe the interview", "Join online / in person", "Get answer hints", "Review the transcript"],
    cta: "Start your interview",
  },
  modes: {
    heading: "WORKS FOR BOTH KINDS OF INTERVIEWS",
    cards: [
      {
        name: "Online interviews",
        body: "Share the meeting tab (Meet/Zoom/Teams) — voices are separated by source: your mic is you, the tab is the interviewer. No bot joins the call.",
      },
      {
        name: "In-person interviews",
        body: "One laptop on the table is enough — both sides are captured through the microphone with automatic speaker detection.",
      },
    ],
  },
  faq: {
    heading: "FREQUENTLY ASKED QUESTIONS",
    items: [
      {
        q: "How is my interview data handled?",
        a: "Audio is transcribed by Soniox and analyzed by Anthropic Claude; transcripts live on Supabase infrastructure and are auto-deleted after 90 days (configurable). We never store audio recordings. Follow any recording rules that apply where you're interviewing.",
      },
      {
        q: "Should I read the answer hint word for word?",
        a: "Better not to. It's a starting point — skim it, then say it in your own words for a more natural answer.",
      },
      {
        q: "Is the trial really free?",
        a: "Every account gets 3 free interviews, no card required. Sessions under 5 minutes (mic checks, technical issues) are automatically refunded.",
      },
      {
        q: "The interviewer speaks Japanese or English — can I read Vietnamese?",
        a: "Yes — the transcript shows the original line with Vietnamese/Japanese/English translations of your choice, both live and afterwards.",
      },
    ],
  },
  ctaBlock: {
    title: "Got an interview coming up? Try it now",
    sub: "Create an account in 30 seconds — 3 free interviews, enough to feel the difference before your next interview.",
    button: "Start for free",
  },
  footer: {
    line1: "HINTS ARE A STARTING POINT — YOU ALWAYS DECIDE WHAT TO SAY.",
    line2: "Interview data auto-deletes after 90 days · Follow the recording rules that apply where you're interviewing.",
  },
};
