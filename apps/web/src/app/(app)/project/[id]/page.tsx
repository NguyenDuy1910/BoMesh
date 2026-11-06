import { ProjectPage } from "@/modules/projects/components/ProjectPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectPage id={decodeURIComponent(id)} />;
}
