import { useState, type ReactNode } from "react";
import { Button, Checkbox, CreateScreen, Input, Label } from "@nonanium/ui";
import { useRegistration } from "../register/useRegistration";
import RightSidePanel from "./rightSidePanel";

function LegalConsent({
  id,
  document,
  href,
  lead,
  checked,
  onAccepted,
}: {
  id: string;
  document: string;
  href: string;
  lead: string;
  checked: boolean;
  onAccepted: (accepted: boolean) => void;
}): ReactNode {
  return (
    <div className="flex items-start gap-3">
      <Checkbox checked={checked} id={id} onCheckedChange={onAccepted} />
      <Label htmlFor={id} className="block! leading-normal">
        I have read and {lead} the{" "}
        <a
          className="ml-1 underline"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {document}
        </a>
        .
      </Label>
    </div>
  );
}

export default function Register() {
  const registration = useRegistration();
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [acceptedPrivacyPolicy, setAcceptedPrivacyPolicy] = useState(false);
  const canRegister =
    registration.initialized && acceptedTerms && acceptedPrivacyPolicy;

  return (
    <CreateScreen>
      <div className="w-full h-full flex justify-center">
        <div className="w-full h-full min-h-0 flex flex-col items-center overflow-y-auto p-6">
          <form
            className="my-auto flex w-full max-w-sm shrink-0 flex-col gap-4"
            onSubmit={registration.submit}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="invitation">Invitation token</Label>
              <Input
                id="invitation"
                value={registration.credential}
                onChange={(event) =>
                  registration.setCredential(event.currentTarget.value)
                }
                readOnly={registration.credentialReadOnly}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                value={registration.username}
                onChange={(event) =>
                  registration.setUsername(event.currentTarget.value)
                }
                autoComplete="username"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Invitation password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="off"
              />
            </div>
            {registration.message && (
              <p className="text-sm text-foreground/75">
                {registration.message}
              </p>
            )}
            <LegalConsent
              id="accept-terms-of-service"
              document="Terms of Service"
              href="https://legal.nonanium.net/tensamin/terms-of-service/"
              lead="accept"
              checked={acceptedTerms}
              onAccepted={setAcceptedTerms}
            />
            <LegalConsent
              id="accept-privacy-policy"
              document="Privacy Policy"
              href="https://legal.nonanium.net/tensamin/privacy-policy/"
              lead="agree to"
              checked={acceptedPrivacyPolicy}
              onAccepted={setAcceptedPrivacyPolicy}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={!canRegister || registration.busy}
              >
                {registration.busy
                  ? "Registering…"
                  : registration.initialized
                    ? "Create account"
                    : "Initializing…"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!registration.canDownloadKeyring}
                onClick={registration.downloadKeyring}
              >
                Download keyring
              </Button>
            </div>
          </form>
        </div>
        <RightSidePanel />
      </div>
    </CreateScreen>
  );
}
