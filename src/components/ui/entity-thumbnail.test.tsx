import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntityThumbnail, ThumbnailPicker } from "./entity-thumbnail";

/**
 * The tile itself is presentational and not worth pinning. Its two decisions
 * are: a picker with `disabled` must offer no way to change the image (it
 * stands in for a permission check the server also enforces, and a control
 * that does nothing is worse than none), and picking the same file twice in a
 * row must fire twice — the input's value is cleared for exactly that reason,
 * and a re-upload after a failed one is the case that breaks without it.
 */

function pngFile(name = "preview.png") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

describe("EntityThumbnail", () => {
  it("renders the image when there is one", () => {
    render(<EntityThumbnail src="https://signed.example/x.png" alt="NANO-1000S" />);
    expect(screen.getByAltText("NANO-1000S")).toBeInTheDocument();
  });

  it("falls back to a placeholder tile rather than a broken image", () => {
    render(<EntityThumbnail src={null} kind="bom" alt="NANO-1000S" />);
    expect(screen.queryByRole("img", { name: "NANO-1000S" })).toBeInTheDocument();
  });
});

describe("ThumbnailPicker", () => {
  it("hands the chosen file to the caller", async () => {
    const onSelect = vi.fn();
    render(<ThumbnailPicker src={null} label="Choose an image" onSelect={onSelect} />);

    const input = screen.getByLabelText("Choose an image").parentElement!.querySelector("input")!;
    await userEvent.upload(input, pngFile());

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBeInstanceOf(File);
  });

  it("fires again when the same file is picked twice", async () => {
    const onSelect = vi.fn();
    render(<ThumbnailPicker src={null} label="Choose an image" onSelect={onSelect} />);

    const input = screen.getByLabelText("Choose an image").parentElement!.querySelector("input")!;
    await userEvent.upload(input, pngFile("same.png"));
    await userEvent.upload(input, pngFile("same.png"));

    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("offers no control at all when disabled", () => {
    render(
      <ThumbnailPicker
        src="https://signed.example/x.png"
        label="Choose"
        onSelect={vi.fn()}
        disabled
      />
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers removal only once there is an image to remove", () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <ThumbnailPicker src={null} label="Choose" onSelect={vi.fn()} onRemove={onRemove} />
    );
    expect(screen.queryByRole("button", { name: /remove image/i })).not.toBeInTheDocument();

    rerender(
      <ThumbnailPicker
        src="https://signed.example/x.png"
        label="Choose"
        onSelect={vi.fn()}
        onRemove={onRemove}
      />
    );
    expect(screen.getByRole("button", { name: /remove image/i })).toBeInTheDocument();
  });
});
