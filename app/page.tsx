import ExperienceNav from './experience-nav';
import './home.css';

// Landing: the three experiences. Each one is its own route, so its 3D and media load only when opened.
const CARDS = [
  {
    href: '/stories/',
    title: 'STORIES',
    name: 'Elsewhere',
    text: 'A city walk that keeps branching. Every scene is a generated video; pick a moment and the story continues from there.',
    image: '/cast/continuity-v2/root.jpg',
  },
  {
    href: '/sim2real/',
    title: 'DELIVERY ROBOT',
    name: 'Worldline',
    text: 'One simulated street, twelve possible futures. Each branch is rendered photoreal by MiniMax H3 from the 3D and checked by SAM 3.',
    image: '/sim2real/slow-right-snow-poster.jpg',
  },
  {
    href: '/flux3/',
    title: 'ROBOT ARM',
    name: 'FLUX 3 Action',
    text: 'A robot policy tested against real SO-101 recordings, replayed on a 3D arm and re-rendered as video.',
    image: '/flux3/compare/cube-human-poster.jpg',
  },
];

export default function Home() {
  return (
    <main className="home">
      <ExperienceNav current="home" />
      <section className="home-cards" aria-label="Experiences">
        {CARDS.map((c) => (
          <a key={c.href} className="home-card" href={c.href}>
            <img src={c.image} alt="" loading="lazy" />
            <span className="home-title">{c.title}</span>
            <span className="home-name">{c.name}</span>
            <span className="home-text">{c.text}</span>
            <span className="home-open">OPEN →</span>
          </a>
        ))}
      </section>
    </main>
  );
}
