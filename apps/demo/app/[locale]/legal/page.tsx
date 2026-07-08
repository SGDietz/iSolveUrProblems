import { BackToPreviousButton } from "../../../src/components/BackToPreviousButton";

const sections: Array<{
  title: string;
  paragraphs?: string[];
  bullets?: string[];
}> = [
  {
    title: "1. ACCEPTANCE OF TERMS",
    paragraphs: [
      "Your access to and use of the Service constitutes full, unconditional, and legally binding acceptance of these terms.",
      "No additional acknowledgment, click-through, or confirmation is required.",
    ],
  },
  {
    title: "2. USE AT YOUR OWN RISK",
    paragraphs: [
      "The Service provides Ai-generated information, suggestions, and problem-solving guidance.",
      "We make no representations or warranties, including but not limited to:",
      "You assume full responsibility for all actions and outcomes.",
    ],
    bullets: ["accuracy", "completeness", "reliability", "safety", "effectiveness", "suitability for any purpose"],
  },
  {
    title: "3. NO PROFESSIONAL ADVICE",
    paragraphs: [
      "The Service does NOT provide:",
      "All content is informational only.",
      "You are solely responsible for verifying information and consulting qualified professionals.",
    ],
    bullets: [
      "legal advice",
      "financial advice",
      "medical advice",
      "engineering or construction advice",
      "licensed or regulated professional services",
    ],
  },
  {
    title: "4. NO GUARANTEES",
    paragraphs: [
      "We make no guarantees regarding:",
      "Any suggestions or recommendations are non-binding and non-guaranteed.",
    ],
    bullets: ["results", "cost savings", "project outcomes", "contractor performance", "safety", "timelines"],
  },
  {
    title: "5. USER RESPONSIBILITY",
    paragraphs: ["You agree that:"],
    bullets: [
      "You are solely responsible for your decisions and actions",
      "You will independently verify all information",
      "You will use licensed professionals where appropriate",
      "You will comply with all applicable laws, codes, and regulations",
    ],
  },
  {
    title: "6. CONTRACTORS, REFERRALS, AND THIRD PARTIES",
    paragraphs: [
      "The Service may:",
      "We do not vet, guarantee, or endorse any third party.",
      "We are not responsible for:",
      "All agreements are solely between you and the third party.",
    ],
    bullets: [
      "recommend contractors or service providers",
      "connect users with third parties",
      "receive referral fees or compensation",
      "performance",
      "safety",
      "licensing",
      "pricing",
      "disputes",
    ],
  },
  {
    title: "7. DATA COLLECTION, RECORDING, AND USE",
    paragraphs: [
      "By using the Service, you explicitly acknowledge and agree that:",
      "Any information you voluntarily provide (including name, email, phone number, or other details) may be collected and retained.",
      "Data may be used for:",
      "Your continued use of the Service constitutes affirmative and legally binding consent to these practices.",
      "If you do not agree, you must immediately discontinue use.",
      "You agree not to submit sensitive information, including:",
      "We are not responsible for any consequences resulting from information you choose to provide.",
      "We do not sell personal data, but may share data with:",
    ],
    bullets: [
      "All interactions, including conversations with Ai systems, may be recorded, stored, analyzed, and used",
      "operating the Service",
      "improving performance",
      "training Ai systems",
      "analytics and optimization",
      "facilitating connections with third parties",
      "financial account data",
      "passwords",
      "social security numbers",
      "confidential or proprietary information",
      "service providers",
      "contractors (when relevant)",
      "analytics tools",
      "legal authorities if required",
    ],
  },
  {
    title: "8. INTELLECTUAL PROPERTY",
    paragraphs: [
      "All content and technology, including:",
      "are the exclusive property of iSolveUrProblems.ai.",
      "You may not:",
      "any part of the Service.",
      "iSolveUrProblems is a trademark of DietzX.",
    ],
    bullets: [
      "software",
      "Ai systems",
      "design",
      "branding",
      "text",
      "functionality",
      "copy",
      "reproduce",
      "distribute",
      "reverse engineer",
      "scrape",
      "exploit",
    ],
  },
  {
    title: "9. LIMITATION OF LIABILITY",
    paragraphs: [
      "TO THE MAXIMUM EXTENT PERMITTED BY LAW:",
      "iSolveUrProblems.ai shall not be liable for:",
      "arising from:",
      "TOTAL LIABILITY SHALL NOT EXCEED $0.",
    ],
    bullets: [
      "direct damages",
      "indirect damages",
      "incidental damages",
      "consequential damages",
      "personal injury",
      "property damage",
      "lost profits",
      "use of the Service",
      "reliance on information",
      "third-party interactions",
    ],
  },
  {
    title: "10. INDEMNIFICATION",
    paragraphs: [
      "You agree to indemnify, defend, and hold harmless iSolveUrProblems.ai from any claims, damages, losses, or expenses arising from:",
    ],
    bullets: [
      "your use of the Service",
      "your actions or decisions",
      "your violation of these terms",
      "your interactions with third parties",
    ],
  },
  {
    title: "11. SERVICE MODIFICATIONS",
    paragraphs: [
      "We may:",
      "any part of the Service at any time, without notice or liability.",
    ],
    bullets: ["modify", "suspend", "restrict", "discontinue"],
  },
  {
    title: "12. TERMINATION",
    paragraphs: [
      "We reserve the right to terminate or restrict access at any time, for any reason, without notice.",
    ],
  },
  {
    title: "13. FUTURE CORPORATE STRUCTURE",
    paragraphs: [
      "The Service may be transferred to or operated by a future legal entity, including a Delaware C-Corporation.",
      "All rights and protections herein shall transfer automatically.",
    ],
  },
  {
    title: "14. GOVERNING LAW",
    paragraphs: ["These terms are governed by the laws of the State of Maryland."],
  },
  {
    title: "15. DISPUTE RESOLUTION",
    paragraphs: ["All disputes shall be resolved through binding arbitration.", "You waive:"],
    bullets: ["the right to a jury trial", "participation in class actions"],
  },
  {
    title: "16. CHANGES TO TERMS",
    paragraphs: [
      "We may update these terms at any time.",
      "Continued use of the Service constitutes acceptance of any changes.",
    ],
  },
  {
    title: "17. CONTACT",
    paragraphs: ["For legal inquiries:"],
    bullets: ["SG@iSolveUrProblems.ai"],
  },
];

export default function LegalPage() {
  return (
    <div className="w-full px-4 py-8 sm:px-6 lg:px-8">
      <BackToPreviousButton />
      <article className="mx-auto w-full max-w-4xl rounded-xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/90 to-[#130a03]/90 p-5 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px] sm:p-8">

        <h1 className="brand-grad-text text-3xl font-bold tracking-wide sm:text-4xl">Terms</h1>
        <p className="mt-3 text-sm text-[#e8b96a]/80 sm:text-base">Effective Date: Jan 01, 2026</p>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
          <p>
            Welcome to iSolveUrProblems.ai ("Company," "we," "our," or "us"). By accessing or using this website,
            platform, or any associated services (collectively, the "Service"), you agree to the following terms.
          </p>
          <p>If you do not agree, you must not use the Service.</p>
        </div>

        <div className="mt-8 space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">{section.title}</h2>
              {section.paragraphs?.map((paragraph) => (
                <p key={paragraph} className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
                  {paragraph}
                </p>
              ))}
              {section.bullets && (
                <ul className="mt-3 list-disc space-y-1 pl-6 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
                  {section.bullets.map((bullet) => (
                    <li key={`${section.title}-${bullet}`}>{bullet}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>

        <section className="mt-10 border-t border-[#e0aa62]/30 pt-6">
          <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">FINAL NOTE</h2>
          <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
            This platform is a tool to assist with thinking and problem-solving.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
            It is not a substitute for professional judgment, experience, or licensed expertise.
          </p>
        </section>
      </article>
    </div>
  );
}
