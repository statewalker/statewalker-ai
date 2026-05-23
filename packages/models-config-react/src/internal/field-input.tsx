import { useBoundProp } from "@json-render/react";
import { Button, Input, Label, cn } from "@statewalker/shadcn-react";
import { Eye, EyeOff } from "lucide-react";
import { type ReactElement, useState } from "react";

interface FieldInputProps {
  props: {
    label?: string | null;
    name: string;
    type?: "text" | "password" | null;
    placeholder?: string | null;
    value?: string | null;
  };
  bindings?: {
    value?: string;
  };
}

/**
 * Bound to the `models-config` catalog's `FieldInput` primitive.
 * Used in place of shadcn `Input` for the Connections form fields so
 * each tab's input is isolated from browser autofill cross-pollution
 * and the API Key field can reveal its value on demand.
 *
 * Stock shadcn `Input` (via `@json-render/shadcn`) lets the browser
 * see four sibling fields with the same logical role
 * (`type="password"` for API Key, `type="text"` for Name) and offer
 * to autofill the same saved value across them. Per-`name` uniqueness
 * helps but the browser still cross-pollutes within the same form
 * context. Setting `autoComplete` explicitly is the reliable opt-out.
 */
export function FieldInput({ props, bindings }: FieldInputProps): ReactElement {
  const [showSecret, setShowSecret] = useState(false);
  const [boundValue, setBoundValue] = useBoundProp(props.value ?? "", bindings?.value);
  const isPassword = props.type === "password";
  const inputType = isPassword && !showSecret ? "password" : "text";
  return (
    <div className="space-y-2">
      {props.label ? <Label htmlFor={props.name}>{props.label}</Label> : null}
      <div className="relative">
        <Input
          id={props.name}
          name={props.name}
          type={inputType}
          placeholder={props.placeholder ?? ""}
          value={boundValue ?? ""}
          onChange={(e) => setBoundValue(e.target.value)}
          autoComplete={isPassword ? "new-password" : "off"}
          // Belt-and-braces: discourage popular password managers
          // (1Password, LastPass) from offering inline UI on these
          // fields — they treat the Settings form as a credential
          // capture target otherwise.
          data-1p-ignore="true"
          data-lpignore="true"
          className={cn(isPassword && "pr-9")}
        />
        {isPassword ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={showSecret ? "Hide value" : "Show value"}
            className="absolute top-1/2 right-1 h-7 w-7 -translate-y-1/2"
            onClick={() => setShowSecret(!showSecret)}
          >
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
