import { LegalDocument, type LegalSection } from "../../../src/components/LegalDocument";

const p = (text: string) => ({ type: "p" as const, text });
const ul = (items: string[]) => ({ type: "ul" as const, items });

const sections: LegalSection[] = [
  {
    title: "1. ACCEPTANCE OF TERMS",
    blocks: [
      p("By accessing or using the Service, you agree to be bound by these Terms."),
      p("If you do not agree, you must not use the Service."),
    ],
  },
  {
    title: "2. USE AT YOUR OWN RISK",
    blocks: [
      p("The Service provides Ai-generated information, suggestions, and problem-solving guidance."),
      p("We make no representations or warranties, including but not limited to:"),
      ul(["accuracy", "completeness", "reliability", "safety", "effectiveness", "suitability for any purpose"]),
      p("You assume full responsibility for all actions and outcomes."),
    ],
  },
  {
    title: "3. NO PROFESSIONAL ADVICE",
    blocks: [
      p("The Service does NOT provide:"),
      ul([
        "legal advice",
        "financial advice",
        "medical advice",
        "engineering or construction advice",
        "licensed or regulated professional services",
      ]),
      p("All content is informational only."),
      p("You are solely responsible for verifying information and consulting qualified professionals."),
    ],
  },
  {
    title: "4. NO GUARANTEES",
    blocks: [
      p("We make no guarantees regarding:"),
      ul(["results", "cost savings", "project outcomes", "contractor performance", "safety", "timelines"]),
      p("Any suggestions or recommendations are non-binding and non-guaranteed."),
    ],
  },
  {
    title: "5. USER RESPONSIBILITY",
    blocks: [
      p("You agree that:"),
      ul([
        "You are at least 18 years old, or the age of majority in your jurisdiction",
        "You are solely responsible for your decisions and actions",
        "You will independently verify all information",
        "You will use licensed professionals where appropriate",
        "You will comply with all applicable laws, codes, and regulations",
      ]),
    ],
  },
  {
    title: "6. CONTRACTORS, REFERRALS, AND THIRD PARTIES",
    blocks: [
      p("The Service may:"),
      ul(["recommend contractors or service providers", "connect users with third parties", "receive referral fees or compensation"]),
      p("We do not vet, guarantee, or endorse any third party."),
      p("We are not responsible for:"),
      ul(["performance", "safety", "licensing", "pricing", "disputes"]),
      p("All agreements are solely between you and the third party."),
    ],
  },
  {
    title: "7. DATA COLLECTION, RECORDING, AND USE",
    blocks: [
      p(
        "Our collection, use, storage, and sharing of your personal information — including recordings and transcripts of your conversations with our Ai systems — is described in our Privacy Policy, which is incorporated into these Terms by reference.",
      ),
      p("By using the Service, you agree to the practices described there. If you do not agree, you must discontinue use immediately."),
    ],
  },
  {
    title: "8. INTELLECTUAL PROPERTY",
    blocks: [
      p("All content and technology, including:"),
      ul(["software", "Ai systems", "design", "branding", "text", "functionality"]),
      p("are the exclusive property of iSolveUrProblems.ai. You may not:"),
      ul(["copy", "reproduce", "distribute", "reverse engineer", "scrape", "exploit"]),
      p("any part of the Service."),
      p('"iSolveUrProblems.ai" is a trademark of DietzX LLC.'),
    ],
  },
  {
    title: "9. LIMITATION OF LIABILITY",
    blocks: [
      p(
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, we and our officers, employees, and agents shall not be liable for any indirect, incidental, consequential, special, or punitive damages — including lost profits, personal injury, or property damage — arising from your use of the Service, your reliance on information provided, or your interactions with third parties, even if advised of the possibility of such damages.",
      ),
      p(
        "To the extent any liability cannot be validly disclaimed under applicable law, our total aggregate liability to you for any claim arising out of or relating to the Service shall not exceed the greater of (a) the amount you paid us in the twelve (12) months preceding the claim, or (b) one hundred dollars ($100).",
      ),
    ],
  },
  {
    title: "10. INDEMNIFICATION",
    blocks: [
      p("You agree to indemnify, defend, and hold harmless the Company from any claims, damages, losses, or expenses arising from:"),
      ul(["your use of the Service", "your actions or decisions", "your violation of these terms", "your interactions with third parties"]),
    ],
  },
  {
    title: "11. SERVICE MODIFICATIONS",
    blocks: [
      p("We may:"),
      ul(["modify", "suspend", "restrict", "discontinue"]),
      p("any part of the Service at any time, without notice or liability."),
    ],
  },
  {
    title: "12. TERMINATION",
    blocks: [p("We reserve the right to terminate or restrict access at any time, for any reason, without notice.")],
  },
  {
    title: "13. ASSIGNMENT AND FUTURE CORPORATE STRUCTURE",
    blocks: [
      p(
        "We may assign, transfer, or delegate this Agreement, in whole or in part, to any successor entity — including a future Delaware C-Corporation or other corporate restructuring of DietzX LLC — without your consent and without notice.",
      ),
      p(
        "This Agreement is binding on and inures to the benefit of the parties and their respective successors and permitted assigns. Any successor entity assumes all rights and obligations under these Terms.",
      ),
    ],
  },
  {
    title: "14. GOVERNING LAW",
    blocks: [
      p("These Terms are governed by the laws of the State of Maryland, without regard to its conflict-of-laws principles."),
      p(
        "DietzX LLC, the entity operating iSolveUrProblems.ai, is organized under the laws of the State of Wyoming. Wyoming law governs the LLC's internal organization and management; Maryland law as stated above governs these Terms as a contract.",
      ),
    ],
  },
  {
    title: "15. DISPUTE RESOLUTION",
    blocks: [
      p(
        "Except for claims that qualify for small claims court, any dispute arising out of or relating to these Terms or the Service will be resolved through binding arbitration administered by the American Arbitration Association (AAA) under its Consumer Arbitration Rules, conducted in Maryland or remotely by video, in English.",
      ),
      p("You and the Company each waive the right to a jury trial and to participate in a class, collective, or representative action."),
      p(
        "You may opt out of this arbitration agreement by emailing legal@iSolveUrProblems.ai within 30 days of first accepting these Terms, stating your name and intent to opt out. If you opt out, disputes will be resolved in the state or federal courts located in Maryland.",
      ),
    ],
  },
  {
    title: "16. CHANGES TO TERMS",
    blocks: [
      p('We may update these Terms at any time. When we do, we\'ll update the "Last Updated" date at the top of this page.'),
      p("Continued use of the Service after a change constitutes acceptance of the updated Terms."),
    ],
  },
  {
    title: "17. CONTACT",
    blocks: [
      p("iSolveUrProblems.ai is operated by DietzX LLC. Authorized representative: Scott G. Dietz, Creator/Builder/CEO."),
      p("For how we handle your personal information, see our Privacy Policy."),
      p("Reach us:"),
      ul([
        "Legal inquiries: legal@iSolveUrProblems.ai",
        "General: Hello@iSolveUrProblems.ai",
        "Bug reports: BugReport@iSolveUrProblems.ai",
        "Direct: SG@iSolveUrProblems.ai",
      ]),
    ],
  },
];

export default function LegalPage() {
  return (
    <LegalDocument
      title="Terms"
      effectiveDate="Jan 01, 2026"
      lastUpdated="Jul 08, 2026"
      intro={[
        'Welcome to iSolveUrProblems.ai (the "Service"), operated by DietzX LLC ("Company," "we," "our," or "us"). By accessing or using the Service, you agree to the following terms.',
        "If you do not agree, you must not use the Service.",
      ]}
      sections={sections}
      finalNoteTitle="FINAL NOTE"
      finalNote={[
        "This platform is a tool to assist with thinking and problem-solving.",
        "It is not a substitute for professional judgment, experience, or licensed expertise.",
      ]}
    />
  );
}
