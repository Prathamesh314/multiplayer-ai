import { ExecutionRequirements } from "./components/ai/ExecutionRequirements";
import type { Metadata } from "next";
import Link from "next/link";
import { AppScreenshot } from "./components/marketing/AppScreenshot";
import { Brand } from "./components/marketing/Brand";
import { DISCORD_INVITE, DiscordIcon, DiscordLink } from "./components/marketing/Community";
import { ChatIcon, GitBranchIcon, TerminalIcon, UsersIcon } from "./components/icons";
import { ProductPreview } from "./components/marketing/ProductPreview";
import { MobileNavigation } from "./components/marketing/MobileNavigation";
import styles from "./components/marketing/marketing.module.css";
import { desktopDownloadUrl } from "./lib/desktop-downloads";
import { DesktopHomeRedirect } from "./components/marketing/DesktopHomeRedirect";
import { InstallCommands } from "./components/marketing/InstallCommands";
import { screenshots } from "./docs/screenshots";

export const metadata: Metadata = {
  title: "Multicode AI — A shared coding room for your team and AI agents",
  description: "Work together with Claude Code, Codex or Gemini in one room, review the room’s changes as a team, and publish them to your project when they’re ready.",
  openGraph: {
    title: "Multicode AI — A shared coding room for your team and AI agents",
    description: "Work together, review the room’s changes, and publish when ready.",
    type: "website",
  },
};

function Arrow({ down = false }: { down?: boolean }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={down ? "M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" : "M4 12h15m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const features = [
  {
    icon: <UsersIcon />,
    title: "Your conversations, connected to the work.",
    body: "Keep talking in Slack or Discord. Share selected public channels with your project so AI can use the discussion and link back to its source.",
    link: { href: "/docs/sharing", label: "Build with your team" },
    shot: screenshots.connections,
  },
  {
    icon: <ChatIcon />,
    title: "Pass the context. Keep the momentum.",
    body: "Follow a teammate’s AI conversation, fork an idea, or hand off a chat. Pick up exactly where the work left off, with the reasoning intact.",
    link: { href: "/docs/first-conversation", label: "Your first conversation" },
    shot: screenshots.handoff,
  },
  {
    icon: <GitBranchIcon />,
    title: "A little room to experiment.",
    body: "Every room gets a Git branch. Explore an idea, review the changes side by side, and publish back to your project only when it is ready.",
    link: { href: "/docs/sharing", label: "Review and publish changes" },
    shot: screenshots.changes,
  },
  {
    icon: <TerminalIcon />,
    title: "Your agents. On your machine.",
    body: "Use the AI tools you already know, with your existing CLI accounts. The paired local runner connects your computer to the shared workspace.",
    link: { href: "/docs/prerequisites", label: "What you need to run agents" },
    shot: screenshots.conversation,
  },
];

const questions = [
  ["What is Multicode AI?", "A collaborative coding workspace for people and AI agents. Bring repositories into a project, work together in rooms, and connect selected Slack or Discord channels for shared context. AI conversations, task assignment, and code review stay together."],
  ["Which AI agents can I use?", "Multicode AI supports Claude Code, Codex, and Gemini through their local command-line tools. Install and sign in to the tools you want to use. Your existing provider account and usage limits apply."],
  ["Where does my code run?", "On a paired computer through the local runner. The desktop app includes the runner; Git and your chosen AI CLI are separate prerequisites. Code and collaboration data are synced with your connected workspace server, so the app needs a network connection."],
  ["What does Multicode AI store, and who can see it?", "The workspace server stores your team’s projects, rooms, chats and the code you add to them, as Git repositories, so teammates with access can review them in a browser. AI tasks run on your own computer through your AI tool’s sign-in: Multicode AI never receives those credentials, and nobody else’s prompts run on your computer. Your AI provider processes prompts under its own terms. Only people you add to a project, or share a room or chat with, can open it."],
  ["Do I need all of the AI tools?", "No. One signed-in tool is enough, such as Claude Code, Codex or Gemini. The app shows which tools each computer has ready, and teammates can each use their own."],
  ["How does working together affect my main branch?", "Each project room has its own Git branch. Build and review in the room, sync the latest project changes, and publish when you are ready to merge your work back. Conflicts are surfaced for review."],
  ["Can I use it in a browser?", "Yes. Open the web workspace to collaborate, review code, and follow conversations. Running AI tasks requires a paired computer with Git and an authenticated agent CLI. The desktop app brings the workspace and local runner together."],
];

const docsCards = [
  ["prerequisites", "01", "Before you start", "Check the computer, Git, account, and AI tool requirements."],
  ["download-install", "02", "Download & set up", "Install on your platform and connect your workspace."],
  ["first-conversation", "03", "Your first conversation", "Start with a repository, or just an idea."],
  ["sharing", "04", "Build with your team", "Invite guests, review changes, and hand off work."],
];

export default function Home() {
  const platforms = [
    { name: "macOS", detail: "Choose your Mac’s processor", icon: "⌘", downloads: [
      { label: "Apple Silicon · .dmg", href: desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_MAC_URL) },
      { label: "Intel Mac · .dmg", href: desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_MAC_INTEL_URL) },
    ] },
    { name: "Windows", detail: "Windows 10 or later · 64-bit", icon: "⊞", downloads: [
      { label: "Windows x64 · .exe", href: desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_WINDOWS_URL) },
    ] },
    { name: "Linux", detail: "64-bit · Ubuntu/Debian package or AppImage", icon: ">_", downloads: [
      { label: "Ubuntu / Debian · .deb", href: desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_LINUX_DEB_URL) },
      { label: "Linux x64 · AppImage", href: desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_LINUX_URL) },
    ] },
  ];
  const available = platforms.some(platform => platform.downloads.some(download => download.href));
  const checksums = desktopDownloadUrl(process.env.DESKTOP_DOWNLOAD_CHECKSUMS_URL);
  const address = (process.env.AUTH_PUBLIC_URL || "https://multicode.in").replace(/\/$/, "");
  // The supported first step: an account in the browser, then the in-app guide. The sign-up page
  // itself says when new accounts need an invitation (this page is prerendered, so it can't).
  const start = { href: "/login?mode=signup&next=%2Fworkspace", label: "Create your team" };

  return (
    <div className={styles.site}>
      <DesktopHomeRedirect />
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <div className={styles.navInner}>
          <Link href="/" aria-label="Multicode AI home"><Brand /></Link>
          <nav className={styles.nav} aria-label="Main navigation">
            <a href="#product">Product</a>
            <a href="#how-it-works">How it works</a>
            <Link href="/docs">Docs</Link>
            <a href="#faq">FAQ</a>
          </nav>
          <div className={styles.navActions}>
            <DiscordLink />
            <Link href="/workspace" className={styles.signIn}>Open workspace</Link>
            <a href="#download" className={styles.navDownload}>Download <Arrow down /></a>
          </div>
          <MobileNavigation />
        </div>
      </header>
      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroGrid} aria-hidden="true" />
          <div className={styles.heroContent}>
            <span className={styles.heroBrand}><Brand /></span>
            <h1><span>A shared coding room</span><span>for your team and AI agents.</span></h1>
            <p className={styles.heroLead}>Work on the same code with your teammates and Claude Code, Codex or Gemini. Review what changed in your room together, and publish it to your project when it’s ready.</p>
            <div className={styles.heroActions}>
              <Link href={start.href} className={styles.primaryButton}>{start.label} <Arrow /></Link>
              <a href="#download" className={styles.secondaryButton}>Download the desktop app <Arrow down /></a>
              <p className={styles.heroNote}>
                Create an account in your browser. A short guide then takes you through your first project, connecting your computer, and inviting a teammate. Invited to a team? Open your invitation link instead.
                <span className={styles.heroNoteMeta}>Already have an account? <Link href="/workspace">Sign in</Link></span>
              </p>
            </div>
          </div>
          <div id="product" className={styles.previewWrap}><ProductPreview /></div>
        </section>

        <section className={styles.providerStrip} aria-label="Supported AI agents">
          <p>Your favorite agents. Now on the same team.</p>
          <div>
            <span><b>✳</b> Claude Code</span>
            <span><b>◎</b> Codex</span>
            <span><b>✦</b> Gemini</span>
            <span className={styles.providerExtra}>Your tools. Your accounts.</span>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="features-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>Less friction. More building.</p>
            <h2 id="features-title">Everyone in the loop. Everything in one place.</h2>
            <p>Give your team and your agents the context to do their best work, and keep the conversation right next to the code it is about.</p>
          </div>
        </section>

        {features.map(feature => (
          <section key={feature.title} className={styles.featureCard}>
            <div className={styles.featureCopy}>
              <span className={styles.featureIcon}>{feature.icon}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </div>
            <div className={styles.featureFrame}><AppScreenshot {...feature.shot} /></div>
            <Link href={feature.link.href} className={styles.learnMore}>{feature.link.label} <Arrow /></Link>
          </section>
        ))}

        <section id="how-it-works" className={`${styles.section} ${styles.workflow}`} aria-labelledby="workflow-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>From “what if” to “shipped”</p>
            <h2 id="workflow-title">How a change gets made, together.</h2>
            <p>Four steps from an invitation to a reviewed change in your project.</p>
          </div>
          <div className={`${styles.steps} ${styles.steps4}`}>{[
            ["01", "A teammate joins", "Invite people to your team and add them to a project. Each of you gets a room on its own Git branch, and can follow each other’s chats from a browser."],
            ["02", "An agent does the work", "Describe a task in your room. Your AI tool runs on your own computer, with your own sign-in, and commits its changes to the room’s branch."],
            ["03", "The team reviews", "Open the diff under Changes, ask a teammate to review it, or hand the chat to someone to finish with their own AI."],
            ["04", "You publish when ready", "Publish the room’s changes to the project when the team agrees. Conflicts with newer project changes are shown for you to resolve first."],
          ].map(([number, title, body]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
        </section>

        <section id="download" className={`${styles.section} ${styles.download}`} aria-labelledby="download-title">
          <div className={styles.downloadHeading}>
            <p className={styles.kicker}>Your next great project starts here</p>
            <h2 id="download-title">Better together. Even better on desktop.</h2>
            <p>A dedicated space for your team, with the local runner built right in. Choose your platform to get started.</p>
          </div>
          <InstallCommands site={address} available={!!checksums} downloads={platforms.flatMap(platform => platform.downloads.map(download => ({ label: `${platform.name} · ${download.label}`, href: download.href })))} />
          <ExecutionRequirements className={styles.requirements} />
          <div className={styles.downloadFootnote}>
            <div>
              <p>After installing, sign in with your account; your computer connects by itself. Prefer a terminal? Connect with Node.js 22+ and <code>npx</code> from <strong>Your computers</strong> in the workspace.</p>
              {checksums && available && <a href={checksums}>Verify download checksums <Arrow /></a>}
            </div>
            <Link href="/workspace" className={styles.learnMore}>Get started in your browser <Arrow /></Link>
          </div>
        </section>

        <section id="docs" className={`${styles.section} ${styles.docsSection}`} aria-labelledby="docs-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>Your workspace, explained</p>
            <h2 id="docs-title">A clear path from setup to teamwork.</h2>
            <p>Step-by-step documentation, real interface screenshots, and answers when you get stuck.</p>
          </div>
          <div className={styles.docsCards}>{docsCards.map(([slug, step, title, body]) => (
            <Link key={slug} href={`/docs/${slug}`}>
              <span className={styles.docsBadge}>{step}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </Link>
          ))}</div>
          <Link href="/docs" className={styles.learnMore}>Explore all docs <Arrow /></Link>
        </section>

        <section id="faq" className={`${styles.section} ${styles.faq}`} aria-labelledby="faq-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>A little more context</p>
            <h2 id="faq-title">Glad you asked.</h2>
          </div>
          <div className={styles.questions}>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div>
        </section>

        <section className={styles.finalCta}>
          <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
          <h2>Build something great.<br /><span>Together.</span></h2>
          <Link href={start.href} className={styles.primaryButton}>{start.label} <Arrow /></Link>
          <p>Already on a team? <Link href="/workspace">Open your workspace</Link></p>
        </section>
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <Link href="/" aria-label="Multicode AI home"><Brand /></Link>
            <p>A shared coding room for your team and AI agents.</p>
          </div>
          <div className={styles.footerColumns}>
            <section>
              <h3>[Product]</h3>
              <div>
                <a href="#product">Product</a>
                <a href="#how-it-works">How it works</a>
                <a href="#download">Downloads</a>
                <a href="#faq">FAQ</a>
                <Link href="/docs/prerequisites#your-data">Where your data lives</Link>
              </div>
            </section>
            <section>
              <h3>[Documentation]</h3>
              <div>
                <Link href="/docs">All docs</Link>
                <Link href="/docs/prerequisites">Before you start</Link>
                <Link href="/docs/download-install">Download &amp; set up</Link>
                <Link href="/docs/first-conversation">Your first conversation</Link>
              </div>
            </section>
            <section>
              <h3>[Workspace]</h3>
              <div>
                <Link href="/workspace">Open workspace</Link>
                <Link href="/login">Sign in</Link>
                <Link href="/account">Your account</Link>
              </div>
            </section>
            <section>
              <h3>[Community]</h3>
              <div>
                <a href={DISCORD_INVITE} target="_blank" rel="noreferrer" className={styles.footerDiscord}>
                  <DiscordIcon />Join us on Discord
                </a>
              </div>
            </section>
          </div>
          <div className={styles.footerMeta}><span>© {new Date().getFullYear()} Multicode AI</span></div>
        </div>
      </footer>
    </div>
  );
}
