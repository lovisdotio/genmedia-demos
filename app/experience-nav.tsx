import './experience-nav.css';

// The three experiences, one top bar shared by every page.
const EXPERIENCES = [
  { id: 'stories', label: 'STORIES', href: '/stories/' },
  { id: 'robot', label: 'DELIVERY ROBOT', href: '/sim2real/' },
  { id: 'arm', label: 'ROBOT ARM', href: '/flux3/' },
] as const;
export type Experience = (typeof EXPERIENCES)[number]['id'] | 'home';

export default function ExperienceNav({ current }: { current: Experience }) {
  return (
    <header className="world-header xp-header">
      <a className="xp-brand" href="/">
        ◉ WORLDLINE
      </a>
      <nav className="xp-nav" aria-label="Experiences">
        {EXPERIENCES.map((x) =>
          x.id === current ? (
            <span key={x.id} className="on" aria-current="page">
              {x.label}
            </span>
          ) : (
            <a key={x.id} href={x.href}>
              {x.label}
            </a>
          ),
        )}
      </nav>
    </header>
  );
}
