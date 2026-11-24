"use client";

import { Button, Modal } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { startTour, useShellOverlays } from "@/components/shell/overlays";
import { markWelcomeSeen, shownTourSteps, welcomeSeen } from "@/components/shell/tour";
import { plural } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";

/**
 * A new member's first visit (preview `M['home-welcome']`, docs/HOME.md › Welcome and product tour): one onboarding entry,
 * by choice. Home renders it once it has finished loading; it opens when nothing else is open and the person hasn't answered
 * it in this workspace on this device. It also confirms joining (joining shows no toast of its own, `welcomesOnArrival`).
 * Later and Escape are an answer; Take a quick tour counts as one once the tour ends. Getting started's "Take the tour"
 * and Help › Product tour bring the tour back any time.
 */
export function HomeWelcome() {
  const { workspace, id } = useWorkspace();
  const user = useSession()?.user.name;
  const { open, tour } = useShellOverlays();
  const [shown, setShown] = useState(false);
  /** The tour's step count, taken when the card opens. */
  const [steps, setSteps] = useState(0);

  useEffect(() => {
    if (!user || open || tour || welcomeSeen(user, id)) return;
    setSteps(shownTourSteps().length);
    setShown(true);
  }, [user, id, open, tour]);

  const later = () => {
    markWelcomeSeen(user, id);
    setShown(false);
  };
  const takeTour = () => {
    setShown(false);
    startTour();
  };

  return (
    <Modal.Backdrop isOpen={shown} isDismissable={false} onOpenChange={(o) => !o && later()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Icon aria-hidden>
              <Sparkles className="i" />
            </Modal.Icon>
            <div className="grow min-w-0">
              <Modal.Heading>{`Welcome to ${workspace.displayName ?? ""}`}</Modal.Heading>
            </div>
          </Modal.Header>
          <Modal.Body>
            <p className="muted">Here you ask questions and get answers from the documents you can read, with their sources.</p>
          </Modal.Body>
          <Modal.Footer>
            <span className="modal__footer-start">{plural(steps, "step")}</span>
            <Button variant="tertiary" onPress={later}>
              Later
            </Button>
            <Button variant="primary" onPress={takeTour} autoFocus>
              Take a quick tour
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
