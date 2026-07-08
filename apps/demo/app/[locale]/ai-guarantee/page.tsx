import { BackToPreviousButton } from "../../../src/components/BackToPreviousButton";

export default function AiGuaranteePage() {
  return (
    <div className="w-full px-4 pb-24 pt-8 sm:px-6 sm:pb-28 lg:px-8">
      <BackToPreviousButton />
      <article className="mx-auto w-full max-w-4xl rounded-xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/90 to-[#130a03]/90 p-5 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px] sm:p-8">
        <h1 className="brand-grad-text text-3xl font-bold tracking-wide sm:text-4xl">The Ai Guarantee</h1>
        <p className="mt-3 text-sm text-[#e8b96a]/80 sm:text-base">Effective Date: Jul 08, 2026</p>

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
          <p>
            6 watches your job from before the first tool comes out to after the last one goes away. That&rsquo;s
            the guarantee.
          </p>
        </div>

        <div className="mt-8 space-y-8">
          <section>
            <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">WHAT WE WATCH</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
              6 is there for every part of the job:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
              <li>Before work starts &mdash; 6 helps assess the actual problem with you</li>
              <li>During the fix or build &mdash; every phase, start to finish</li>
              <li>The contractor documents the work as it happens</li>
              <li>When it&rsquo;s done &mdash; the whole job is documented, not just the invoice</li>
            </ul>
          </section>

          <section>
            <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">WHAT &ldquo;GUARANTEE&rdquo; MEANS HERE</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
              This is not a guarantee that the job goes perfectly, costs a certain amount, or finishes by a certain
              date &mdash; our{" "}
              <a href="/legal" className="underline decoration-[#e0aa62]/60 underline-offset-2 hover:text-[#ffe9c2]">
                Terms
              </a>{" "}
              cover why we can&rsquo;t promise that, and no honest company can.
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
              What we guarantee is that it&rsquo;s <em>watched and documented</em>, top to bottom. You get a real
              record of what happened, not just a memory of what someone told you. We don&rsquo;t know another
              business that does this for every job, start to finish.
            </p>
          </section>

          <section>
            <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">HONEST ABOUT WHERE WE ARE</h2>
            <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
              This is new. 6 is still learning what to look for and how to document it well. Early jobs may be
              rougher than later ones &mdash; we&rsquo;d rather tell you that upfront than pretend otherwise.
            </p>
          </section>
        </div>

        <section className="mt-10 border-t border-[#e0aa62]/30 pt-6">
          <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">AI-CERTIFIED</h2>
          <p className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
            A job 6 watches start to finish carries the Ai-Certified mark &mdash; our sign that someone was
            paying attention the whole way through.
          </p>
        </section>
      </article>
    </div>
  );
}
