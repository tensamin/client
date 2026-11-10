import PasswordSettings from "@tensamin/login/passwordSettings";
import ClearStorageButton from "@tensamin/shared/clearStorageButton";

export default function Page() {
  return (
    <div className="flex flex-col gap-8">
      <PasswordSettings />
      <div>
        <ClearStorageButton />
      </div>
    </div>
  );
}
