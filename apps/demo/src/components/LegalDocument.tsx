import { BackToPreviousButton } from "./BackToPreviousButton";

export type LegalBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

export type LegalSection = {
  title: string;
  blocks: LegalBlock[];
};

/**
 * Shared renderer for /legal and /privacy. Blocks (not separate
 * paragraphs+bullets arrays) so a bullet list renders directly under the
 * sentence it belongs to, in document order — the old shape rendered every
 * paragraph first, then dumped every bullet from a section into one list at
 * the end, scrambling meaning in any section with more than one list
 * (2026-07-08 audit finding).
 */
export function LegalDocument({
  title,
  effectiveDate,
  lastUpdated,
  intro,
  sections,
  finalNoteTitle,
  finalNote,
}: {
  title: string;
  effectiveDate: string;
  lastUpdated?: string;
  intro: string[];
  sections: LegalSection[];
  finalNoteTitle: string;
  finalNote: string[];
}) {
  return (
    <div className="w-full px-4 pb-24 pt-8 sm:px-6 sm:pb-28 lg:px-8">
      <BackToPreviousButton />
      <article className="mx-auto w-full max-w-4xl rounded-xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/90 to-[#130a03]/90 p-5 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px] sm:p-8">
        <h1 className="brand-grad-text text-3xl font-bold tracking-wide sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-[#e8b96a]/80 sm:text-base">Effective Date: {effectiveDate}</p>
        {lastUpdated && (
          <p className="mt-1 text-sm text-[#e8b96a]/60 sm:text-base">Last Updated: {lastUpdated}</p>
        )}

        <div className="mt-6 space-y-4 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
          {intro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>

        <div className="mt-8 space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">{section.title}</h2>
              {section.blocks.map((block, i) =>
                block.type === "p" ? (
                  <p key={i} className="mt-3 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base">
                    {block.text}
                  </p>
                ) : (
                  <ul
                    key={i}
                    className="mt-3 list-disc space-y-1 pl-6 text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base"
                  >
                    {block.items.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </section>
          ))}
        </div>

        <section className="mt-10 border-t border-[#e0aa62]/30 pt-6">
          <h2 className="brand-grad-text text-lg font-semibold sm:text-xl">{finalNoteTitle}</h2>
          {finalNote.map((paragraph, i) => (
            <p
              key={paragraph}
              className={`text-sm leading-relaxed text-[#ffe9c2]/90 sm:text-base ${i === 0 ? "mt-3" : "mt-2"}`}
            >
              {paragraph}
            </p>
          ))}
        </section>
      </article>
    </div>
  );
}
