import { access } from "node:fs/promises";

export async function executableIsAvailable(executable: string): Promise<boolean> {
  if (executable.includes("/") || executable.includes("\\")) {
    return access(executable)
      .then(() => true)
      .catch(() => false);
  }
  return true;
}
