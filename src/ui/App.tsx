import { Activity, CheckCircle2, GitBranch, ShieldCheck } from "lucide-react";
import "./styles.css";

const providerNeutralTerms = ["projects", "agents", "sessions", "turns", "approvals", "file changes", "checks"];

export function App() {
  return (
    <main className="appShell">
      <nav className="leftNav" aria-label="Primary">
        <strong>Praxis</strong>
        <a href="#dashboard">Dashboard</a>
        <a href="#projects">Projects</a>
        <a href="#approvals">Approvals</a>
        <a href="#activity">Activity</a>
        <a href="#checks">Checks</a>
        <a href="#providers">Providers</a>
        <a href="#settings">Settings</a>
      </nav>
      <section className="mainPanel" id="dashboard">
        <header className="topBar">
          <div>
            <p className="eyebrow">Provider-neutral control plane</p>
            <h1>Project dashboard</h1>
          </div>
          <div className="statusRail" aria-label="Global status">
            <span><Activity size={16} /> 0 active turns</span>
            <span><ShieldCheck size={16} /> 0 approvals</span>
            <span><CheckCircle2 size={16} /> 0 failed checks</span>
          </div>
        </header>
        <section className="emptyState" aria-labelledby="empty-title">
          <GitBranch size={40} aria-hidden="true" />
          <h2 id="empty-title">Register a project to begin</h2>
          <p>
            Praxis tracks {providerNeutralTerms.join(", ")} as durable state. The fake provider is available for local
            workflows and tests.
          </p>
          <button type="button">Register project</button>
        </section>
      </section>
      <aside className="detailPanel" aria-label="Details">
        <h2>Explain state</h2>
        <p>Dashboard modes are derived from events, propositions, and evidence.</p>
      </aside>
    </main>
  );
}
