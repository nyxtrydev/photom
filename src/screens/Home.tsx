import { DropZone } from '@/components/DropZone';
import { RecentProjects } from '@/components/RecentProjects';
import { useFileDrop } from '@/hooks/useFileDrop';
import { strings } from '@/i18n/strings';
import hero from '@/assets/illustrations/hero.png';

export function Home() {
  const hovering = useFileDrop();
  return (
    <div className="flex-1 overflow-y-auto">
      <section className="relative h-[430px] overflow-hidden bg-gradient-to-br from-app to-muted">
        <img
          src={hero}
          alt={strings.home.heroAlt}
          draggable={false}
          className="hero-art pointer-events-none absolute bottom-0 right-0 h-full w-auto max-w-[45%] object-cover object-left"
        />
        <div className="absolute inset-y-5 left-5 right-[30%] min-w-[420px]">
          <DropZone hovering={hovering} />
        </div>
      </section>
      <RecentProjects />
    </div>
  );
}
