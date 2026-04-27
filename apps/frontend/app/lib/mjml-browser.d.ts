declare module 'mjml-browser' {
  interface MjmlResult {
    html: string;
    errors: Array<{ message: string; tagName?: string; line?: number }>;
  }
  function mjml2html(mjml: string, options?: { minify?: boolean }): MjmlResult;
  export default mjml2html;
}
