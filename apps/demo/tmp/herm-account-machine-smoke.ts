import { strict as assert } from "node:assert";
import { accountSetupSpeechFlow, type SignupFlags, type SignupPorts } from "../src/lib/signup/machine.js";

type State = {
  awaitingReady: boolean;
  awaitingEmail: boolean;
  awaitingName: boolean;
  awaitingSend: boolean;
  awaitingPostSendOffer: boolean;
  pendingEmail: string | null;
  rejectedEmail: string | null;
  sendEmail: string | null;
  emailMissCount: number;
  offerMade: boolean;
  declinedAt: number;
  lastParsedEmail: string | null;
  sendArmedAt: number;
  sendArmedByText: string | null;
  signedIn: boolean;
  avatarTalking: boolean;
  name: string | null;
  greetingCount: number;
  chestText: string;
  said: string[];
  startedEmails: string[];
};

const flags: SignupFlags = {
  accountBetaDisabled: false,
  emailTypedFallbackEnabled: false,
};

function makePorts(initial?: Partial<State>): { state: State; ports: SignupPorts } {
  const state: State = {
    awaitingReady: false,
    awaitingEmail: false,
    awaitingName: false,
    awaitingSend: false,
    awaitingPostSendOffer: false,
    pendingEmail: null,
    rejectedEmail: null,
    sendEmail: null,
    emailMissCount: 0,
    offerMade: false,
    declinedAt: 0,
    lastParsedEmail: null,
    sendArmedAt: 0,
    sendArmedByText: null,
    signedIn: false,
    avatarTalking: false,
    name: null,
    greetingCount: 0,
    chestText: "",
    said: [],
    startedEmails: [],
    ...initial,
  };

  const ports: SignupPorts = {
    get awaitingReady() { return state.awaitingReady; },
    set awaitingReady(v: boolean) { state.awaitingReady = v; },
    get awaitingEmail() { return state.awaitingEmail; },
    set awaitingEmail(v: boolean) { state.awaitingEmail = v; },
    get awaitingName() { return state.awaitingName; },
    set awaitingName(v: boolean) { state.awaitingName = v; },
    get awaitingSend() { return state.awaitingSend; },
    set awaitingSend(v: boolean) { state.awaitingSend = v; },
    get awaitingPostSendOffer() { return state.awaitingPostSendOffer; },
    set awaitingPostSendOffer(v: boolean) { state.awaitingPostSendOffer = v; },
    get pendingEmail() { return state.pendingEmail; },
    set pendingEmail(v: string | null) { state.pendingEmail = v; },
    get rejectedEmail() { return state.rejectedEmail; },
    set rejectedEmail(v: string | null) { state.rejectedEmail = v; },
    get sendEmail() { return state.sendEmail; },
    set sendEmail(v: string | null) { state.sendEmail = v; },
    get emailMissCount() { return state.emailMissCount; },
    set emailMissCount(v: number) { state.emailMissCount = v; },
    get offerMade() { return state.offerMade; },
    set offerMade(v: boolean) { state.offerMade = v; },
    get declinedAt() { return state.declinedAt; },
    set declinedAt(v: number) { state.declinedAt = v; },
    get lastParsedEmail() { return state.lastParsedEmail; },
    set lastParsedEmail(v: string | null) { state.lastParsedEmail = v; },
    get sendArmedAt() { return state.sendArmedAt; },
    set sendArmedAt(v: number) { state.sendArmedAt = v; },
    get sendArmedByText() { return state.sendArmedByText; },
    set sendArmedByText(v: string | null) { state.sendArmedByText = v; },
    get signedIn() { return state.signedIn; },
    get avatarTalking() { return state.avatarTalking; },
    get userName() { return state.name; },
    get greetingCount() { return state.greetingCount; },
    get chestText() { return state.chestText; },
    async say(text: string) { state.said.push(text); },
    saveName(name: string) { state.name = name; },
    showChest() {},
    setChestDisplay(text: string) { state.chestText = text; },
    async revealChars(_fromText: string, addedChars: string) { state.chestText += addedChars; },
    clearRevealActive() {},
    openTypedBox() {},
    closeTypedBox() {},
    setTypedEmail(value: string) { state.chestText = value; },
    async startAccountSetup(email: string) { state.startedEmails.push(email); return true; },
    clearEntry() {
      state.awaitingReady = false;
      state.awaitingEmail = false;
      state.awaitingName = false;
      state.awaitingSend = false;
      state.awaitingPostSendOffer = false;
      state.pendingEmail = null;
      state.rejectedEmail = null;
      state.sendEmail = null;
      state.chestText = "";
    },
    now() { return 10_000; },
  };

  return { state, ports };
}

async function turn(ports: SignupPorts, text: string): Promise<boolean> {
  return accountSetupSpeechFlow(ports, flags, text);
}

async function testNameAfterEmailOutOfOrder() {
  const { state, ports } = makePorts();

  assert.equal(await turn(ports, "remember me next time"), true);
  assert.equal(state.awaitingName, true);
  assert.match(state.said.at(-1) ?? "", /^You got it\. First - what should I call you\?$/);
  assert.doesNotMatch(state.said.join("\n"), /Love it/i);

  // User gives the email before the name. This used to strand the flow or re-ask
  // in the wrong order. It must park the email, confirm it, then ask for the name.
  assert.equal(await turn(ports, "my email is herm.smoke@example.com"), true);
  assert.equal(state.pendingEmail, "herm.smoke@example.com");
  assert.equal(state.awaitingName, false);
  assert.match(state.said.at(-1) ?? "", /Is the email on screen correct\?/);

  assert.equal(await turn(ports, "yes that's correct"), true);
  assert.equal(state.pendingEmail, null);
  assert.equal(state.sendEmail, "herm.smoke@example.com");
  assert.equal(state.awaitingName, true);
  assert.equal(state.awaitingSend, false);
  assert.match(state.said.at(-1) ?? "", /what should I call you, so I can say hey by name next time\?/);

  assert.equal(await turn(ports, "George"), true);
  assert.equal(state.name, "George");
  assert.equal(state.awaitingName, false);
  assert.equal(state.awaitingSend, true);
  assert.match(state.said.at(-1) ?? "", /Thanks, George\. Want me to send the sign-in link to that email now\?/);

  assert.equal(await turn(ports, "yes send it"), true);
  assert.deepEqual(state.startedEmails, ["herm.smoke@example.com"]);
  assert.equal(state.awaitingSend, false);
  assert.equal(state.sendEmail, null);
}

async function testPostSendOfferGate() {
  const wrap = makePorts({ awaitingPostSendOffer: true });
  assert.equal(await turn(wrap.ports, "wrap up for now"), true);
  assert.equal(wrap.state.awaitingPostSendOffer, false);
  assert.match(wrap.state.said.at(-1) ?? "", /You're all set\. Check your email/);

  const keep = makePorts({ awaitingPostSendOffer: true });
  assert.equal(await turn(keep.ports, "keep going"), false);
  assert.equal(keep.state.awaitingPostSendOffer, false);
  assert.equal(keep.state.said.length, 0);
}

async function main() {
  await testNameAfterEmailOutOfOrder();
  await testPostSendOfferGate();
  console.log("PASS herm-account-machine-smoke: name-after-email, no-'Love it', send consent, post-send offer");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
