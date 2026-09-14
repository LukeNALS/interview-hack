import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { AppHeader } from "@/components/common/app-header";

/** Logo = đường về home theo phản xạ web; trang chia sẻ công khai phải TẮT được. */

afterEach(cleanup);

test("test_app_header_logo_links_to_candidate_by_default", () => {
  // Arrange + Act
  render(<AppHeader />);

  // Assert
  const link = screen.getByRole("link", { name: "Về màn chuẩn bị" });
  expect(link).toHaveAttribute("href", "/candidate");
});

test("test_app_header_logo_href_null_renders_plain_logo_without_link", () => {
  // Arrange + Act — trang chia sẻ công khai (khách chưa đăng nhập)
  render(<AppHeader logoHref={null} />);

  // Assert
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.getByText("Interview")).toBeInTheDocument();
});
