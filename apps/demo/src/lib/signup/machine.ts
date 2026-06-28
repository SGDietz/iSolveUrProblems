// The verbal-signup decision machine for 6.
// CARVED 2026-06-10 from src/components/LiveAvatarSession.tsx — each flow below
// is a LITERAL port of the component callback it replaces (same branches, same
// spoken lines, same state writes, in the same order). The component implements
// SignupPorts over its existing refs/setters; the replay harness implements it
// over a plain object. ONE brain, two bodies — the tests drive the same code
// that runs on the site.
//
// Original callbacks → flows:
//   openEmailEntry              → openTypedEntryFlow
//   handleEmailMiss             → emailMissFlow
//   confirmAccountEmailCandidate→ confirmEmailCandidateFlow
//   appendSpelledEmailFromSpeech→ appendSpelledEmailFlow
//   handleAccountSetupSpeech    → accountSetupSpeechFlow
//   (email fast-path gate)      → takesEmailFastPath
import { extractContactDetails } from "../contactExtraction";
import {
  ACCOUNT_FIRST_TIME_RE,
  ACCOUNT_UNSURE_RE,
  ACCOUNT_READY_NO_RE,
  ACCOUNT_READY_YES_RE,
  ACCOUNT_RETURNING_RE,
  ACCOUNT_SETUP_TRIGGER_RE,
  EMAIL_ENTRY_REQUEST_RE,
  buildAccountMemoryOffer,
  extractAccountEmailCandidate,
  extractDeviceNameCandidate,
  hasEndSessionIntent,
  isAccountConsentYes,
  isValidEmailCandidate,
  mergeEmailDomainCorrection,
  parseSpelledEmailChunk,
} from "./helpers";
import { normalizeUtterance } from "../speech/dedupe";

export interface SignupFlags {
  accountBetaDisabled: boolean;
  emailTypedFallbackEnabled: boolean;
}

// State fields mirror the component refs 1:1 (component wires get/set pairs to
// the refs; the harness uses plain properties). Effects are the component's
// side-channel: voice, chest box, typed box, network send.
export interface SignupPorts {
  // -- machine state (read/write) --
  awaitingReady: boolean; // accountSetupAwaitingReadyRef
  awaitingEmail: boolean; // accountSetupAwaitingEmailRef
  awaitingName: boolean; // accountSetupAwaitingNameRef
  awaitingSend: boolean; // accountSetupAwaitingSendRef
  awaitingPostSendOffer: boolean; // accountSetupAwaitingPostSendOfferRef
  pendingEmail: string | null; // accountSetupPendingEmailRef
  rejectedEmail: string | null; // accountSetupRejectedEmailRef
  sendEmail: string | null; // accountSetupSendEmailRef
  emailMissCount: number; // accountSetupEmailMissCountRef
  offerMade: boolean; // accountSetupOfferMadeRef
  declinedAt: number; // accountSetupDeclinedAtRef
  lastParsedEmail: string | null; // lastAvatarParsedEmailRef
  // STT echo guard (2026-06-11): the utterance + moment that ARMED the send
  // gate. A normalized-identical utterance arriving within the echo window
  // must not also FIRE the gate (G's doubled "Perfect." mailed the link
  // before the consent question was even asked).
  sendArmedAt: number; // accountSetupSendArmedAtRef
  sendArmedByText: string | null; // accountSetupSendArmedByTextRef
  // -- context (read-only for the machine) --
  readonly signedIn: boolean; // accountSignedInRef
  readonly avatarTalking: boolean; // isAvatarTalkingRef
  readonly userName: string | null; // deviceProfileRef.current.name
  readonly greetingCount: number; // deviceProfileRef.current.greetingCount
  readonly chestText: string; // chestEmailTextRef (synced to display state)
  // -- effects --
  say(text: string, opts?: { remember?: boolean }): Promise<void>;
  saveName(name: string): void;
  showChest(): void;
  setChestDisplay(text: string): void;
  revealChars(fromText: string, addedChars: string): Promise<void>;
  clearRevealActive(): void;
  openTypedBox(): void;
  closeTypedBox(): void;
  setTypedEmail(value: string): void;
  startAccountSetup(email: string): Promise<boolean>;
  clearEntry(): void;
  now(): number;
}

// The dispatch gate from handleUserTranscription: while 6 is collecting the
// email, route speech straight to the account flow — but a genuine close must
// ALWAYS escape (G 2026-06-03 "he could not close the session").
export function takesEmailFastPath(
  ports: SignupPorts,
  flags: SignupFlags,
  userText: string,
): boolean {
  return (
    !flags.accountBetaDisabled &&
    (ports.awaitingEmail || ports.pendingEmail !== null) &&
    !hasEndSessionIntent(userText)
  );
}

export async function openTypedEntryFlow(
  ports: SignupPorts,
  flags: SignupFlags,
  spoken?: string,
): Promise<boolean> {
  // G (2026-06-01): the typed box is dormant (EMAIL_TYPED_FALLBACK_ENABLED).
  // While false, never open it — keep the user on the spell-on-chest path.
  if (!flags.emailTypedFallbackEnabled) {
    ports.showChest();
    await ports.say("Please spell it slowly.");
    return true;
  }
  ports.openTypedBox();
  await ports.say(
    spoken ||
      "I opened the email box so you can type it. Check that it looks right on screen before I send anything.",
  );
  return true;
}

export async function emailMissFlow(
  ports: SignupPorts,
  flags: SignupFlags,
  spokenBeforeTypedFallback?: string,
): Promise<boolean> {
  ports.emailMissCount += 1;
  // Spell-on-chest is the primary path. The typed box is dormant per G
  // (EMAIL_TYPED_FALLBACK_ENABLED); while false, never fall back to it —
  // keep the on-chest box up and keep asking the user to spell.
  if (flags.emailTypedFallbackEnabled && ports.emailMissCount >= 3) {
    return openTypedEntryFlow(
      ports,
      flags,
      spokenBeforeTypedFallback ||
        "I'm still not catching it. You can type your email address in here instead.",
    );
  }
  ports.showChest();
  await ports.say("Please spell it slowly.");
  return true;
}

export async function confirmEmailCandidateFlow(
  ports: SignupPorts,
  email: string,
): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  // CHANGE 2 (2026-06-01): when 6 is mid-sentence or has driven the box from
  // his own readback, suppress the frontend's competing scripted line. The
  // box still updates; 6's single voice carries the conversation.
  const sixIsCarryingVoice =
    ports.avatarTalking || ports.lastParsedEmail !== null;
  if (!isValidEmailCandidate(normalizedEmail)) {
    // GUARD (2026-06-07, G "why is he saying spell slowly again?"): if a
    // valid address is already pending / parked for send, a stray partial
    // readback must NOT drag the user back to "spell it slowly". Ignore it.
    if (ports.pendingEmail || ports.sendEmail || ports.awaitingSend) {
      return true;
    }
    // Not a complete address yet — keep the user on the spell-on-chest path
    // and never save a guess.
    ports.awaitingEmail = true;
    ports.setChestDisplay(normalizedEmail);
    ports.showChest();
    if (!sixIsCarryingVoice) {
      await ports.say("Please spell it slowly.");
    }
    return true;
  }
  ports.pendingEmail = normalizedEmail;
  ports.rejectedEmail = null;
  ports.awaitingEmail = false;
  ports.awaitingReady = false;
  ports.emailMissCount = 0;
  ports.closeTypedBox();
  ports.setTypedEmail(normalizedEmail);
  // FIX 1: show the captured address on 6's chest and ask for confirmation
  // WITHOUT 6 ever speaking the address out loud. The box on screen is what
  // the user checks — that sidesteps mis-heard / mangled spoken readbacks.
  // G 2026-06-10: an INLINE address gets the same letter-by-letter typewriter
  // reveal the spelled path gets ("it should have come up earlier with those
  // typewriter sounds"). Skip when the box already shows this address — the
  // spelled path animated it on the way in.
  if (ports.chestText.replace(/-/g, "") !== normalizedEmail) {
    ports.setChestDisplay("");
    ports.showChest();
    await ports.revealChars("", normalizedEmail);
    ports.clearRevealActive();
  }
  ports.setChestDisplay(normalizedEmail);
  ports.showChest();
  // CHANGE 2: don't ask "Is the email on screen correct?" over 6 — if he's
  // already talking / just read it back, his own voice handles the ask.
  if (!sixIsCarryingVoice) {
    await ports.say("Is the email on screen correct?");
  }
  return true;
}

export async function appendSpelledEmailFlow(
  ports: SignupPorts,
  flags: SignupFlags,
  userText: string,
): Promise<boolean> {
  const { chars, looksSpelled } = parseSpelledEmailChunk(userText);
  // CHANGE 2 (2026-06-01): kill the double-voice. During the email flow 6's
  // own brain is already talking (asking, confirming the readback). The
  // frontend must NOT fire its own competing scripted lines over him. When
  // 6 is mid-sentence OR has already driven the box from his readback, we
  // do the VISUAL work (box) but stay silent and let his one voice carry.
  const sixIsCarryingVoice =
    ports.avatarTalking || ports.lastParsedEmail !== null;

  if (!looksSpelled || !chars) {
    // Couldn't read it as a spelled address. Keep what we have, ask again.
    ports.emailMissCount += 1;
    ports.showChest();
    // Typed-box fallback is dormant (EMAIL_TYPED_FALLBACK_ENABLED). While
    // false, keep the on-chest box up and keep asking them to spell.
    if (flags.emailTypedFallbackEnabled && ports.emailMissCount >= 3) {
      return openTypedEntryFlow(
        ports,
        flags,
        "I'm still not catching it. You can type your email address in here instead.",
      );
    }
    if (!sixIsCarryingVoice) {
      await ports.say("Please spell it slowly.");
    }
    return true;
  }

  // FIX (2026-06-01, G "box went back to placeholder after the email was
  // correctly put in"): once 6 has driven a COMPLETE, valid address into the
  // box (his readback is authoritative), do NOT let further raw-STT
  // "spelling" append junk onto it or blank it back to the placeholder. The
  // user is confirming at this point, not re-spelling — keep the address on
  // screen and wait for their yes/no. A "no" re-spell clears it elsewhere.
  if (ports.lastParsedEmail !== null && isValidEmailCandidate(ports.chestText)) {
    ports.showChest();
    return true;
  }

  // Accumulate onto whatever is already on the chest, then normalize.
  // G 2026-06-01 ("g-d-i-e-t-z@pm.me — not sure what this is"): the STT inserts
  // DASHES between spelled letters. Strip them so the box shows a CLEAN address
  // (gdietz@pm.me, never g-d-i-e-t-z@pm.me) — dash dropped from the kept set
  // AND scrubbed from anything already on screen.
  const prev = ports.chestText.replace(/-/g, "");
  const nextRaw = `${prev}${chars}`.toLowerCase();
  const nextEmail = nextRaw.replace(/[^a-z0-9._%+@]/g, "");
  const addedChars = nextEmail.slice(prev.length);
  ports.showChest();
  ports.emailMissCount = 0;

  const completesAddress = isValidEmailCandidate(nextEmail);

  if (completesAddress) {
    // G 2026-06-09: animate the COMPLETING chunk too - he wants to SEE each
    // letter land + HEAR the click even when STT delivers the whole address
    // at once ("no typewriter sound, didn't see each letter"). It also lets
    // him CATCH a mangled spelling as it types out. Await the reveal so the
    // box is fully settled BEFORE 6 confirms - awaiting fixes the old overlap
    // worry. revealChars cancels any prior pending reveal itself.
    await ports.revealChars(prev, addedChars);
    ports.clearRevealActive();
    ports.setChestDisplay(nextEmail);
    return confirmEmailCandidateFlow(ports, nextEmail);
  }

  // Still building: reveal the newly added characters one at a time
  // (typewriter clicks), then let the user keep going.
  await ports.revealChars(prev, addedChars);

  // Stay in awaiting-email mode and let the user keep going.
  ports.awaitingEmail = true;
  // CHANGE 2: stay silent if 6 is already talking / carrying the readback —
  // the box updated visually, no competing "Got it. Keep going." over him.
  if (!sixIsCarryingVoice) {
    await ports.say("Got it. Keep going.");
  }
  return true;
}

export async function accountSetupSpeechFlow(
  ports: SignupPorts,
  flags: SignupFlags,
  userText: string,
): Promise<boolean> {
  if (flags.accountBetaDisabled) {
    if (!ACCOUNT_SETUP_TRIGGER_RE.test(userText)) return false;
    ports.clearEntry();
    await ports.say(
      "For this beta, every new session starts blank. I can help with this session right now.",
    );
    return true;
  }

  // SIGNED-IN users are already set up — bail before ANY account setup so the
  // email-on-chest box + email parsing can't fire on the post-click return
  // (it was grabbing normal speech like "okay so" / "website" as fake emails
  // — G 2026-06-03). Anonymous/new users (ref=false) still sign up normally.
  if (ports.signedIn) {
    return false;
  }

  // FIX C (2026-06-01): we asked for the name and are waiting on it. Take
  // this utterance as the name (allow a bare answer like "G"), save it into
  // deviceProfile so startAccountSetup sends a real fullName, then move on
  // to the email step. If we can't make out a name, ask once more rather
  // than silently dropping to email with a NULL name.
  if (ports.awaitingName) {
    // A clear cancel still bails cleanly (don't trap the user at the name
    // step). ACCOUNT_READY_NO_RE covers "no / not now / later / cancel".
    if (ACCOUNT_READY_NO_RE.test(userText)) {
      ports.awaitingName = false;
      ports.awaitingEmail = false;
      ports.awaitingReady = false;
      ports.declinedAt = ports.now();
      ports.offerMade = false;
      await ports.say(
        "No problem. We can keep using this session. When you want me to remember next time, we'll set it up.",
      );
      return true;
    }
    // KEVIN-SESSION FIX (2026-06-10): if they give an EMAIL while we wait on
    // the name (the brain asks steps out of order), TAKE the email — never
    // trap them in name-collection. The name gets picked up conversationally.
    const nameTurnEmail = extractAccountEmailCandidate(
      userText,
      extractContactDetails(userText).email,
    );
    if (nameTurnEmail) {
      ports.awaitingName = false;
      return confirmEmailCandidateFlow(ports, nameTurnEmail);
    }
    const nameCandidate = extractDeviceNameCandidate(userText, true);
    if (nameCandidate) {
      ports.saveName(nameCandidate);
      ports.awaitingName = false;
      // NAME-AFTER-EMAIL: if a confirmed address is already parked, the name was
      // the LAST thing missing — arm the send gate now instead of re-asking for
      // an email we already have.
      if (ports.sendEmail) {
        ports.awaitingSend = true;
        ports.sendArmedAt = ports.now();
        ports.sendArmedByText = userText;
        await ports.say(
          `Thanks, ${nameCandidate}. Want me to send the sign-in link to that email now?`,
        );
        return true;
      }
      ports.awaitingEmail = true;
      ports.pendingEmail = null;
      ports.rejectedEmail = null;
      ports.emailMissCount = 0;
      ports.closeTypedBox();
      ports.setTypedEmail("");
      ports.lastParsedEmail = null;
      ports.setChestDisplay("");
      ports.showChest();
      await ports.say(
        `Thanks, ${nameCandidate}. Now spell your email slowly, one letter at a time. It will show on my chest as you go.`,
      );
      return true;
    }
    // KEVIN-SESSION FIX (2026-06-10): a long sentence is the user talking
    // ABOUT something ("Go ahead, what were you saying, Six?"), not a failed
    // name answer. The old behavior ate every such turn with "Sorry, I didn't
    // catch your name" on loop. Let the brain answer; keep listening for a
    // name-shaped reply — the gate stays armed.
    if (userText.trim().split(/\s+/).length > 6) {
      return false;
    }
    await ports.say("Sorry, I didn't catch your name. What should I call you?");
    return true;
  }

  const contact = extractContactDetails(userText);
  const correctedEmail = mergeEmailDomainCorrection(
    userText,
    ports.pendingEmail ?? ports.rejectedEmail,
  );
  const directEmail =
    extractAccountEmailCandidate(userText, contact.email) ?? correctedEmail;

  if (
    EMAIL_ENTRY_REQUEST_RE.test(userText) &&
    (ports.awaitingEmail ||
      ports.awaitingReady ||
      ports.pendingEmail ||
      ACCOUNT_SETUP_TRIGGER_RE.test(userText))
  ) {
    ports.awaitingReady = false;
    ports.awaitingEmail = true;
    return openTypedEntryFlow(
      ports,
      flags,
      "Yes. I opened the email box so you can type it. Check that it looks right on screen before I send anything.",
    );
  }

  if (ports.awaitingPostSendOffer) {
    // After the link is sent, 6 asked "keep working, or wrap up?". A finish/no
    // closes with a sign-off; a keep-going/yes drops the gate and hands the turn
    // back to normal conversation. Anything unclear re-asks once.
    if (ACCOUNT_READY_NO_RE.test(userText)) {
      ports.awaitingPostSendOffer = false;
      if (!ports.avatarTalking) {
        await ports.say(
          "You're all set. Check your email when you get a sec - I'll be right here.",
        );
      }
      return true;
    }
    if (ACCOUNT_READY_YES_RE.test(userText)) {
      ports.awaitingPostSendOffer = false;
      return false; // let the brain carry the conversation forward
    }
    if (!ports.avatarTalking) {
      await ports.say("Want to keep going, or wrap up for now?");
    }
    return true;
  }

  if (ports.awaitingSend) {
    if (ACCOUNT_READY_NO_RE.test(userText)) {
      ports.awaitingSend = false;
      ports.sendEmail = null;
      ports.sendArmedByText = null;
      if (!ports.avatarTalking) {
        await ports.say(
          "No problem, I'll hold off. Just ask me to set up the account whenever you're ready.",
        );
      }
      return true;
    }
    if (isAccountConsentYes(userText)) {
      // STT ECHO GUARD (2026-06-11, G: "You sent it without me giving you
      // permission"): his "Perfect." arrived twice — the first confirmed the
      // email and ARMED this gate, the duplicate one beat later FIRED it.
      // The exact words that armed the gate can never also fire it inside
      // the echo window; a real consent is a different sentence ("yes",
      // "send it") spoken after 6 actually asks.
      if (
        ports.sendArmedByText !== null &&
        normalizeUtterance(userText) ===
          normalizeUtterance(ports.sendArmedByText) &&
        ports.now() - ports.sendArmedAt < 4000
      ) {
        return true;
      }
      const emailToSend = ports.sendEmail;
      ports.awaitingSend = false;
      ports.sendEmail = null;
      ports.sendArmedByText = null;
      if (emailToSend) {
        return await ports.startAccountSetup(emailToSend);
      }
    }
    // Unclear answer at the send gate — nudge once, then stay put.
    if (!ports.avatarTalking) {
      await ports.say(
        "Just say yes and I'll send the sign-in link, or no to hold off.",
      );
    }
    return true;
  }

  if (ports.pendingEmail) {
    // CHANGE 1 (2026-06-01): 6's confirmed readback is authoritative. When
    // it drove the pending value (lastParsedEmail set), do NOT let a raw-STT
    // directEmail (which mangles spelled letters) overwrite it — the user
    // must say "no" to re-spell. Only the typed/clean path (no 6 readback)
    // may still swap the candidate inline.
    if (
      directEmail &&
      directEmail !== ports.pendingEmail &&
      ports.lastParsedEmail === null
    ) {
      return confirmEmailCandidateFlow(ports, directEmail);
    }
    if (isAccountConsentYes(userText)) {
      // Email confirmed CORRECT. Do NOT send yet — get explicit send consent
      // first (G 2026-06-03: "ask permission before sending; the user says
      // yes, THEN send"). Park the confirmed address on the send gate.
      ports.sendEmail = ports.pendingEmail;
      ports.pendingEmail = null;
      ports.awaitingEmail = false;
      ports.awaitingReady = false;
      ports.rejectedEmail = null;
      // NAME-AFTER-EMAIL (G 2026-06-27): the email is confirmed but we still
      // don't have a name. Grab it casually now so 6 can greet by name next
      // time, THEN arm the send gate. sendEmail stays parked; the awaitingName
      // handler routes a captured name straight to the send gate.
      if (!ports.userName) {
        ports.awaitingName = true;
        if (!ports.avatarTalking) {
          await ports.say(
            "Perfect. And what should I call you, so I can say hey by name next time?",
          );
        }
        return true;
      }
      ports.awaitingSend = true;
      ports.sendArmedAt = ports.now();
      ports.sendArmedByText = userText;
      if (!ports.avatarTalking) {
        await ports.say(
          "Perfect. Want me to send the sign-in link to that email now?",
        );
      }
      return true;
    }
    if (ACCOUNT_READY_NO_RE.test(userText)) {
      ports.rejectedEmail = ports.pendingEmail;
      ports.pendingEmail = null;
      ports.awaitingEmail = true;
      ports.awaitingReady = false;
      ports.emailMissCount = 0;
      // FIX 1: clear the on-chest box and let the user spell it again from
      // scratch. Never carry a rejected address forward.
      // CHANGE 1: also forget 6's last parsed readback so his next
      // confirmation re-reveals into the box.
      ports.lastParsedEmail = null;
      ports.setChestDisplay("");
      ports.showChest();
      // CHANGE 2: stay quiet if 6 is still talking — don't step on him.
      if (!ports.avatarTalking) {
        await ports.say("Okay, let's try again. Please spell it slowly.");
      }
      return true;
    }
    // CHANGE 2: only nudge for a yes/no when 6 is NOT mid-sentence. If he's
    // talking (e.g. still asking "Did I get that right?"), let him finish.
    if (!ports.avatarTalking) {
      await ports.say(
        "Before I send the account email, I need a yes or no. Is that email address correct?",
      );
    }
    return true;
  }

  // BUGFIX (2026-06-10, G's smoke transcript 12:02): the user spoke a clean
  // inline address ("wildworks@pm.me") while the machine was still at the
  // READY gate, so the scripted flow ignored it — the email went out via the
  // silent server auto-trigger and NOBODY announced the send ("you need to
  // tell me you sent it"). An inline email at the ready gate is the user
  // jumping ahead — capture it; confirmEmailCandidateFlow clears the gates.
  if ((ports.awaitingEmail || ports.awaitingReady) && directEmail) {
    return confirmEmailCandidateFlow(ports, directEmail);
  }

  if (ports.awaitingEmail) {
    // PRIMARY path: the user is spelling their email aloud. Build it up on
    // 6's chest letter-by-letter; never guess a full address from words.
    return appendSpelledEmailFlow(ports, flags, userText);
  }

  if (ports.awaitingReady) {
    if (ACCOUNT_READY_NO_RE.test(userText)) {
      ports.awaitingReady = false;
      ports.awaitingEmail = false;
      ports.pendingEmail = null;
      ports.rejectedEmail = null;
      ports.declinedAt = ports.now();
      ports.offerMade = false;
      ports.emailMissCount = 0;
      ports.closeTypedBox();
      await ports.say(
        "No problem. We can keep using this session. When you want me to remember next time, we'll set it up.",
      );
      return true;
    }
    // r18: "I'm not sure. You tell me." — unsure still advances; the email
    // lookup decides new-vs-existing, the user never has to remember. Checked
    // BEFORE the yes-branch: "not sure" contains the bare yes-word "sure" and
    // would otherwise get the generic spell line instead of "I'll check".
    if (ACCOUNT_UNSURE_RE.test(userText)) {
      if (!ports.userName) {
        ports.awaitingReady = false;
        ports.awaitingEmail = false;
        ports.awaitingName = true;
        await ports.say("No problem - I can check. First, what's your name?");
        return true;
      }
      ports.awaitingReady = false;
      ports.awaitingEmail = true;
      ports.pendingEmail = null;
      ports.rejectedEmail = null;
      ports.emailMissCount = 0;
      ports.closeTypedBox();
      ports.setTypedEmail("");
      ports.lastParsedEmail = null;
      ports.setChestDisplay("");
      ports.showChest();
      await ports.say(
        "No problem - spell your email slowly and I'll check. It will show on my chest as you go.",
      );
      return true;
    }
    // TRACER FIX (2026-06-10, G's 13:11 session): the brain asks its own
    // "first time signing up, or already have an account?" while we sit at
    // this gate. "Uh, first time signing up." matched neither yes nor no, the
    // machine stalled ARMED, and the brain freelanced the whole signup (name
    // re-ask, mangled readbacks, a send that never happened). A first-time or
    // returning answer IS the user moving signup forward — treat it like yes.
    // Returning users take the same path: spell the email, get the link.
    if (
      ACCOUNT_READY_YES_RE.test(userText) ||
      ACCOUNT_FIRST_TIME_RE.test(userText) ||
      ACCOUNT_RETURNING_RE.test(userText)
    ) {
      // FIX C (2026-06-01): capture the NAME before the email step. If we
      // don't have one yet, ask for it now and wait — the next utterance is
      // taken as the name (handled by the awaiting-name branch above). This
      // is why captured_lists.fullName was NULL: 6 went straight to email.
      if (!ports.userName) {
        ports.awaitingReady = false;
        ports.awaitingEmail = false;
        ports.awaitingName = true;
        await ports.say("Great. First, what's your name?");
        return true;
      }
      ports.awaitingReady = false;
      ports.awaitingEmail = true;
      ports.pendingEmail = null;
      ports.rejectedEmail = null;
      ports.emailMissCount = 0;
      ports.closeTypedBox();
      ports.setTypedEmail("");
      // FIX 1: prime the on-chest box for a fresh spell.
      // CHANGE 1: forget any prior parsed readback for the clean start.
      ports.lastParsedEmail = null;
      ports.setChestDisplay("");
      ports.showChest();
      await ports.say(
        "Great. Spell your email slowly, one letter at a time. It will show on my chest as you go.",
      );
      return true;
    }
  }

  if (ACCOUNT_SETUP_TRIGGER_RE.test(userText)) {
    // Always capture the NAME first, even if they blurted the email — going
    // straight to email here is why captured_lists.fullName saved EMPTY and
    // 6 had to ask the name again on return (G 2026-06-03).
    if (!ports.userName) {
      ports.awaitingReady = false;
      ports.awaitingEmail = false;
      ports.awaitingName = true;
      await ports.say("Love it. First - what should I call you?");
      return true;
    }
    if (directEmail) {
      return confirmEmailCandidateFlow(ports, directEmail);
    }
    ports.awaitingReady = true;
    ports.awaitingEmail = false;
    ports.pendingEmail = null;
    ports.rejectedEmail = null;
    ports.emailMissCount = 0;
    await ports.say(
      buildAccountMemoryOffer(
        "You can use the site right now. Account setup is optional, but it lets me remember you next time.",
        ports.greetingCount + 1,
      ),
      { remember: true },
    );
    return true;
  }

  return false;
}
