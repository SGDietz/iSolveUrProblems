import { LegalDocument, type LegalSection } from "../../../src/components/LegalDocument";

const p = (text: string) => ({ type: "p" as const, text });
const ul = (items: string[]) => ({ type: "ul" as const, items });

const sections: LegalSection[] = [
  {
    title: "1. WHO WE ARE",
    blocks: [
      p('iSolveUrProblems.ai ("Company," "we," "our," or "us") is operated by DietzX LLC, a Wyoming company.'),
      p("We built the Service for people in the United States. If you use it from somewhere else, your information is still handled the way this policy describes."),
    ],
  },
  {
    title: "2. INFORMATION YOU GIVE US",
    blocks: [
      p("When you use the Service, you may give us:"),
      ul([
        "your name",
        "your email address",
        "your phone number",
        "your property address",
        "what you type or say to 6",
        "photos or videos you choose to share",
        "your state contractor license number, if you sign up as a pro",
        "payment details, if you ever sign up for a paid plan (Stripe handles this directly — we don't see or store your full card number)",
      ]),
    ],
  },
  {
    title: "3. INFORMATION WE COLLECT AUTOMATICALLY",
    blocks: [
      p("Just by using the Service, we also collect:"),
      ul([
        "a record (transcript) of your conversations with 6",
        "audio and video from your live sessions with 6, while the session is happening",
        "basic device and usage info, like browser type and pages visited",
        "GPS location and a timestamp attached to photos or videos taken during a job",
        "sign-in activity, so we know your account is really you",
      ]),
    ],
  },
  {
    title: "4. WHAT 6 REMEMBERS ABOUT YOU",
    blocks: [
      p("6 keeps short notes between conversations, so you don't have to repeat yourself — things like your name, address, property details, preferences, or a problem you mentioned before."),
      p("You are always in control of these notes. Go to your account page to see every note 6 has saved."),
      p("You can delete any single note, or wipe everything 6 remembers about you, at any time. Deletion is immediate and permanent — we don't keep a hidden copy."),
      p("This is one of the strongest privacy controls we offer, and we built it because you should own your own data."),
    ],
  },
  {
    title: "5. HOW YOUR CONVERSATIONS WITH 6 ARE PROCESSED",
    blocks: [
      p("When you talk to 6, your voice and video are streamed through HeyGen's LiveAvatar system, which renders 6's face and voice in real time."),
      p("Your words are turned into text and sent to Ai language providers — OpenAI and Google (Gemini) — so 6 can understand you and answer."),
      p('If you share a photo (like a picture of a leaky pipe), we may send it to OpenAI or Google Gemini so 6 can "see" and describe what\'s in it.'),
      p("These providers process your conversation only to power your session with 6. See their own privacy policies for how they separately handle data."),
      p("We store the transcript of your conversation in our database so you can pick up where you left off, and so we can improve 6 over time."),
    ],
  },
  {
    title: "6. PHONE CALLS AND MESSAGES",
    blocks: [
      p("Some calls you place through the Service — for example, calling a contractor for an estimate — are placed using Twilio, our calling and messaging provider."),
      p("We'll ask for your consent before a call is recorded. If you consent, we keep a copy of the recording so you and the contractor have a record of what was discussed."),
      p("If you tap to call a contractor directly from your own phone, that call is between you and them — we don't record it."),
      p("If you ask us to text or WhatsApp you a report, you'll check a consent box first. Message and data rates may apply, and you can reply STOP at any time to stop texts."),
    ],
  },
  {
    title: "7. PHOTOS, VIDEOS, AND JOB LOCATION DATA",
    blocks: [
      p("If you're a contractor, the Service lets you log arrival, progress, and completion photos or videos for a job. Each entry can include the GPS location and time it was taken, plus an Ai-generated caption describing what's in it."),
      p("This job log is shared with the homeowner on that job, so they have a record of the work. We treat location data as sensitive and limit who can see it to you, the homeowner, and us."),
    ],
  },
  {
    title: "8. CONTRACTOR LICENSE VERIFICATION",
    blocks: [
      p('If you claim a business profile as a contractor, we check your state license number against your state\'s licensing board to award a "License-Verified" badge.'),
      p("We never publish your license number. It's used only for that one-time verification."),
    ],
  },
  {
    title: "9. HOW WE USE YOUR INFORMATION",
    blocks: [
      p("We use the information we collect to:"),
      ul([
        "run and operate the Service",
        "let 6 understand you and hold a real conversation",
        "remember your preferences, with your permission",
        "connect you with a contractor you choose to contact",
        "send the reports, texts, or emails you asked for",
        "verify contractor licenses",
        "process payments, once paid plans are live",
        "detect fraud, abuse, and keep the Service safe",
        "fix bugs and improve 6",
        "follow the law",
      ]),
    ],
  },
  {
    title: "10. WHO WE SHARE INFORMATION WITH",
    blocks: [
      p("We do not sell your personal information, and we haven't sold or shared it for advertising in the past 12 months."),
      p("We share information only as needed to run the Service, with:"),
      ul([
        "Supabase — our database, file storage, and sign-in provider",
        "OpenAI — processes text and photos so 6 can understand and answer you",
        "Google (Gemini) — processes text and photos so 6 can understand and answer you",
        "HeyGen (LiveAvatar) — renders 6's real-time voice and video during your session",
        "Twilio — sends texts and WhatsApp messages, and connects phone calls you ask for",
        "Resend — sends account and report emails",
        "Stripe — will process payments once paid plans are turned on; we don't have paid plans live yet",
        "Dropbox Sign — handles e-signatures on contracts you choose to sign through the Service",
        "Outscraper and similar data providers — supply public contractor business listings; this is public business data, not your personal data",
        "Vercel — hosts our website and app",
        "a contractor you choose to contact — only what's needed for them to help you, and only after you say yes",
        "law enforcement or regulators, only if the law requires it",
        "a future buyer of the Company — if we're ever acquired or merged, under the same privacy protections",
      ]),
    ],
  },
  {
    title: "11. COOKIES AND SIMILAR TECHNOLOGY",
    blocks: [
      p("We use essential cookies to keep you signed in and remember your language and session — nothing works without them."),
      p("We do not use third-party advertising trackers, and we do not sell data to ad networks."),
      p("Where the law requires it, we honor Global Privacy Control (GPC) browser signals as a valid opt-out request."),
    ],
  },
  {
    title: "12. HOW LONG WE KEEP INFORMATION",
    blocks: [
      p("We keep your account and conversation history as long as your account is active, so 6 can pick up where you left off."),
      p("Memory notes are kept until you delete them — deletion is immediate."),
      p("Job log photos and videos are kept as your service record. Contact us if you'd like yours removed."),
      p("We may keep limited records after you close your account where the law requires it (for example, financial records), or to resolve an open dispute."),
    ],
  },
  {
    title: "13. HOW WE PROTECT YOUR INFORMATION",
    blocks: [
      p("We use encrypted connections (HTTPS) and store your data on Supabase's encrypted infrastructure."),
      p("We limit access to your information to what each part of the Service actually needs to function."),
      p("No system is 100% secure. If something goes wrong, we'll notify you as required by law."),
    ],
  },
  {
    title: "14. YOUR PRIVACY CHOICES AND RIGHTS",
    blocks: [
      p("No matter where you live, you can:"),
      ul([
        "see what 6 remembers about you, and delete any note or all of it, any time — right in the app",
        "ask us what personal information we have about you",
        "ask us to correct information that's wrong",
        "ask us to delete your account and personal information",
        "ask for a copy of your information",
        "tell us to stop a specific use of your information",
        "withdraw any consent you gave us, at any time",
      ]),
    ],
  },
  {
    title: "15. CALIFORNIA PRIVACY RIGHTS (CCPA)",
    blocks: [
      p("If you live in California, state law gives you the rights listed above by name: the right to know, delete, correct, opt out of sale or sharing, limit use of sensitive personal information (like precise location), and not be discriminated against for using these rights."),
      p("We do not sell or share your personal information as those terms are defined under California law."),
      p("To use any of these rights, email legal@iSolveUrProblems.ai. We'll verify it's really you and respond within 30 days."),
    ],
  },
  {
    title: "16. VISITORS OUTSIDE THE UNITED STATES",
    blocks: [
      p("The Service is built for the United States, and your information is processed here."),
      p("As good practice — even though we're a small US company — we extend the same rights described above (access, correction, deletion, portability, objection, and withdrawing consent) to visitors from the EU, UK, and anywhere else."),
      p("If you're outside the US and have a concern we haven't resolved, you may also contact your local data protection authority."),
    ],
  },
  {
    title: "17. CHILDREN'S PRIVACY",
    blocks: [
      p("The Service is not intended for children under 13. We do not knowingly collect information from anyone under 13."),
      p("If we learn a child under 13 has given us information, we will delete it. If you believe this has happened, contact us right away."),
    ],
  },
  {
    title: "18. CHANGES TO THIS POLICY",
    blocks: [
      p('We may update this Privacy Policy as the Service changes. We\'ll update the "Last Updated" date at the top when we do.'),
      p("For a change that matters — like a new way we use your data — we'll make a reasonable effort to let you know, such as an in-app notice or an email."),
      p("Continuing to use the Service after a change means you accept the update."),
    ],
  },
  {
    title: "19. CONTACT US",
    blocks: [
      p("iSolveUrProblems.ai is operated by DietzX LLC. Authorized representative: Scott G. Dietz, Creator/Builder/CEO."),
      p("Reach us:"),
      ul([
        "Privacy questions and data requests: legal@iSolveUrProblems.ai",
        "General: Hello@iSolveUrProblems.ai",
        "Bug reports: BugReport@iSolveUrProblems.ai",
        "Direct: SG@iSolveUrProblems.ai",
      ]),
    ],
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      title="Privacy Policy"
      effectiveDate="Jul 08, 2026"
      intro={[
        'This Privacy Policy explains what information iSolveUrProblems.ai ("Company," "we," "our," or "us") collects when you use our website, app, and voice/video assistant ("6") — together, the "Service" — how we use it, and the choices you have.',
        "This Privacy Policy works alongside our Terms. If you don't agree with this policy, please don't use the Service.",
      ]}
      sections={sections}
      finalNoteTitle="A PLAIN-LANGUAGE PROMISE"
      finalNote={[
        "We wrote this policy the way we'd want it written for us — in plain English, not legal fog.",
        "If anything here is unclear, email us. We'll explain it in plain language, not legalese.",
      ]}
    />
  );
}
