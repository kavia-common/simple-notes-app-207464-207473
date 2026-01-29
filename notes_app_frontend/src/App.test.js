import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Retro Notes header", () => {
  render(<App />);
  expect(screen.getByText(/retro notes/i)).toBeInTheDocument();
});
