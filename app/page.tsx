import type { Metadata } from "next";
import Link from "next/link";
import { AppScreenshot } from "./components/marketing/AppScreenshot";
import { ChatIcon, GitBranchIcon, TerminalIcon, UsersIcon } from "./components/icons";
import { ProductPreview } from "./components/marketing/ProductPreview";
import { MobileNavigation } from "./components/marketing/MobileNavigation";
import styles from "./components/marketing/marketing.module.css";

export const metadata: Metadata = {
  title: "Multiplayer AI — Great software is a team sport.",
  description: "Bring your team, code, and AI agents into one shared workspace. Build together with Claude Code, Codex, and Gemini. Discover Multiplayer AI for desktop and web.",
  openGraph: {
    title: "Multiplayer AI — Build something great. Together.",
    description: "Your people. Your AI agents. One shared workspace.",
    type: "website",
  },
};

function downloadUrl(value: string | undefined, placeholder: string) {
  if (value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password) return { href: url.href, demo: false };
    } catch { /* An invalid release URL falls back to the labeled demo link. */ }
  }
  return { href: `https://example.com/downloads/${placeholder}`, demo: true };
}

function Arrow({ down = false }: { down?: boolean }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={down ? "M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" : "M4 12h15m-6-6 6 6-6 6"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Brand() {
  return <span className={styles.brand}><span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>multiplayer<span className={styles.brandAi}>ai</span></span>;
}

const questions = [
  ["What is Multiplayer AI?", "A collaborative coding workspace for people and AI agents. Bring a repository into a project, open a room, and work together with a code editor, terminal, team chat, and AI conversations in one place."],
  ["Which AI agents can I use?", "Multiplayer AI supports Claude Code, Codex, and Gemini through their local command-line tools. Install and sign in to the tools you want to use. Your existing provider account and usage limits apply."],
  ["Where does my code run?", "On a paired computer through the local runner. The desktop app includes the runner; Git and your chosen AI CLI are separate prerequisites. Code and collaboration data are synced with your connected workspace server, so the app needs a network connection."],
  ["How does working together affect my main branch?", "Each project room has its own Git branch. Build and review in the room, sync the latest project changes, and publish when you are ready to merge your work back. Conflicts are surfaced for review."],
  ["Can I use it in a browser?", "Yes. Open the web workspace to collaborate, review code, and follow conversations. Running AI tasks requires a paired computer with Git and an authenticated agent CLI. The desktop app brings the workspace and local runner together."],
];

export default function Home() {
  const platforms = [
    { name: "macOS", detail: "Desktop app for your Mac", icon: "⌘", ...downloadUrl(process.env.DESKTOP_DOWNLOAD_MAC_URL, "Multiplayer-AI.dmg") },
    { name: "Windows", detail: "Desktop installer", icon: "⊞", ...downloadUrl(process.env.DESKTOP_DOWNLOAD_WINDOWS_URL, "Multiplayer-AI-Setup.exe") },
    { name: "Linux", detail: "AppImage · Preview", icon: ">_", ...downloadUrl(process.env.DESKTOP_DOWNLOAD_LINUX_URL, "Multiplayer-AI.AppImage") },
  ];

  return (
    <div className={styles.site}>
      <a href="#main-content" className={styles.skipLink}>Skip to content</a>
      <header className={styles.header}>
        <div className={styles.navInner}>
          <Link href="/" aria-label="Multiplayer AI home"><Brand /></Link>
          <nav className={styles.nav} aria-label="Main navigation"><a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="#faq">FAQ</a></nav>
          <div className={styles.navActions}><Link href="/workspace" className={styles.signIn}>Open workspace <span aria-hidden="true">↗</span></Link><a href="#download" className={styles.navDownload}>Get the app <Arrow down /></a></div>
          <MobileNavigation />
        </div>
      </header>
      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroGrid} aria-hidden="true" />
          <div className={styles.heroContent}>
            <a className={styles.eyebrowPill} href="#product"><span className={styles.liveDot} /> A new way to build, together <span aria-hidden="true">↗</span></a>
            <h1>Great software<br />is a <span>team sport.</span></h1>
            <p>Your people. Your AI agents. One shared workspace.<br className={styles.desktopBreak} /> Go from the first idea to the next commit, together.</p>
            <div className={styles.heroActions}><a href="#download" className={styles.primaryButton}>Get Multiplayer AI <Arrow down /></a><a href="#product" className={styles.secondaryButton}>Explore the workspace <Arrow /></a></div>
            <div className={styles.heroNote}><span className={styles.tinyAvatars}><i>A</i><i>S</i><i>✳</i></span><span>Built for teams. Made for the way you code.</span></div>
          </div>
          <div id="product" className={styles.previewWrap}><ProductPreview /></div>
          <div className={styles.providerStrip}><p>YOUR FAVORITE AGENTS. NOW ON THE SAME TEAM.</p><div><span><b className={styles.claudeMark}>✳</b> Claude Code</span><span><b className={styles.codexMark}>◎</b> Codex</span><span><b className={styles.geminiMark}>✦</b> Gemini</span><span className={styles.providerExtra}>Your tools. Your choice.</span></div></div>
        </section>
        <section className={`${styles.section} ${styles.features}`} aria-labelledby="features-title">
          <div className={styles.sectionHeading}><div><p className={styles.kicker}>LESS FRICTION. MORE BUILDING.</p><h2 id="features-title">Everyone in the loop.<br /><span>Everything in one place.</span></h2></div><p>Give your team and AI the context to do their best work. Keep the conversation right next to the code.</p></div>
          <div className={styles.featureGrid}>
            <article className={styles.featureCard}><div className={styles.featureCopy}><span className={styles.featureIcon}><UsersIcon /></span><h3>Goodbye, solo mode.</h3><p>Open a room and bring your team along. See who’s here, follow the work live, and turn “can you send me that?” into shared context.</p></div><AppScreenshot src="/product/team-chat.png" alt="The actual team chat, with channels, a shared conversation, and the member list." width={1440} height={900} label="Team channels" focus="team" /></article>
            <article className={styles.featureCard}><div className={styles.featureCopy}><span className={styles.featureIcon}><ChatIcon /></span><h3>Pass the context.<br />Keep the momentum.</h3><p>Follow a teammate’s AI conversation, fork an idea, or hand off a chat. Pick up where the work left off.</p></div><AppScreenshot src="/product/chat-handoff.png" alt="Choose a teammate and leave context in the app’s Hand off this chat dialog." width={1256} height={786} label="Chat handoff" focus="handoff" /></article>
            <article className={styles.featureCard}><div className={styles.featureCopy}><span className={styles.featureIcon}><GitBranchIcon /></span><h3>A little room to experiment.</h3><p>Every room gets a Git branch. Explore an idea, review the changes, and publish back to your project when it’s ready.</p></div><AppScreenshot src="/product/code-review.png" alt="The real code editor and Changes panel, with Publish and Get latest in the toolbar." width={1256} height={786} label="Code & review" focus="code" /></article>
            <article className={styles.featureCard}><div className={styles.featureCopy}><span className={styles.featureIcon}><TerminalIcon /></span><h3>Your agents. On your machine.</h3><p>Use the AI tools you already know, with your existing CLI accounts. The paired local runner connects your computer to the shared workspace.</p></div><AppScreenshot src="/product/ai-conversation.png" alt="A real Codex CLI result in the app, running through a paired local computer." width={1256} height={786} label="AI conversations" focus="agent" /></article>
          </div>
        </section>
        <section id="how-it-works" className={`${styles.section} ${styles.workflow}`} aria-labelledby="workflow-title"><p className={styles.kicker}>FROM “WHAT IF” TO “SHIPPED”</p><h2 id="workflow-title">Find your flow. Together.</h2><div className={styles.steps}>{[
          ["01", "Bring your project", "Start with your repository. Give your team a shared home for the code, conversations, and decisions that matter."],
          ["02", "Make room for the work", "Open a room, invite your teammates, and choose an AI agent. Build in parallel with the context close at hand."],
          ["03", "Make the next move", "Review a diff. Ask for a second opinion. Hand off a task. Publish your room’s changes when the team is ready."],
        ].map(([number, title, body]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></article>)}</div></section>
        <section id="download" className={`${styles.section} ${styles.download}`} aria-labelledby="download-title"><div className={styles.downloadHeading}><div><p className={styles.kicker}>YOUR NEXT GREAT PROJECT STARTS HERE</p><h2 id="download-title">Better, together.<br /><span>Even better on desktop.</span></h2></div><p>A dedicated space for your team, with a local runner built right in. Choose your platform to get started.</p></div><div className={styles.downloadGrid}>{platforms.map(platform => <article key={platform.name}><span className={styles.platformIcon} aria-hidden="true">{platform.icon}</span><h3>{platform.name}</h3><p>{platform.detail}</p><a href={platform.href} className={styles.platformDownload} aria-describedby={platform.demo ? "download-demo-note" : undefined}>Download for {platform.name} <Arrow down /></a>{platform.demo && <small>Demo link · Release coming soon</small>}</article>)}</div><div className={styles.downloadFootnote}><div><p>Requires a workspace connection, Git, and a signed-in AI CLI.</p>{platforms.some(platform => platform.demo) && <p id="download-demo-note">Demo download links are placeholders. Installers are not published yet.</p>}</div><Link href="/workspace">Get started in your browser <Arrow /></Link></div></section>
        <section id="faq" className={`${styles.section} ${styles.faq}`} aria-labelledby="faq-title"><div><p className={styles.kicker}>A LITTLE MORE CONTEXT</p><h2 id="faq-title">Glad you asked.</h2><p>The details, before you dive in.</p></div><div className={styles.questions}>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>
        <section className={styles.finalCta}><span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span><h2>Build something great.<br /><span>Together.</span></h2><Link href="/workspace" className={styles.primaryButton}>Open your workspace <Arrow /></Link><p>Good ideas deserve good company.</p></section>
      </main>
      <footer className={styles.footer}><Link href="/" aria-label="Multiplayer AI home"><Brand /></Link><p>A shared space for your next big idea.</p><nav aria-label="Footer navigation"><a href="#product">Product</a><a href="#download">Downloads</a><a href="#faq">FAQ</a></nav><span>© {new Date().getFullYear()} Multiplayer AI</span></footer>
    </div>
  );
}
