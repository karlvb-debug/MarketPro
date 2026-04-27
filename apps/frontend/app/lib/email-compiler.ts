// ============================================
// Email Block Editor — MJML Compiler
// Converts EmailDesign JSON → MJML string → HTML
// ============================================

import type {
  EmailDesign,
  EmailBlock,
  HeadingProps,
  TextProps,
  ImageProps,
  ButtonProps,
  DividerProps,
  ColumnsProps,
  SpacerProps,
  SocialProps,
  FooterProps,
} from './email-templates';

// --- Heading sizes ---
const HEADING_SIZES: Record<string, string> = {
  h1: '28px',
  h2: '22px',
  h3: '18px',
};

// --- Escape HTML attribute ---
function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Compile a single block to MJML ---
function compileBlock(block: EmailBlock): string {
  const blockBg = (block.props as any)?.blockBgColor;
  const blockBgImg = (block.props as any)?.blockBgImage;
  const blockPad = (block.props as any)?.blockPadding;
  const inner = compileBlockInner(block);
  if (!inner) return '';

  // If block has custom block-level styling, wrap in its own section
  if (blockBg || blockBgImg || blockPad) {
    const bgColorAttr = blockBg ? ` background-color="${esc(blockBg)}"` : '';
    const bgImgAttr = blockBgImg ? ` background-url="${esc(blockBgImg)}" background-size="cover" background-position="center center"` : '';
    const padAttr = blockPad ? ` padding="${esc(blockPad)}"` : ' padding="0"';
    return `  </mj-column>
  </mj-section>
  <mj-section${bgColorAttr}${bgImgAttr}${padAttr}>
  <mj-column>
${inner}
  </mj-column>
  </mj-section>
  <mj-section background-color="{{CONTENT_BG}}" padding="0">
  <mj-column>`;
  }

  return inner;
}

function compileBlockInner(block: EmailBlock): string {
  switch (block.type) {
    case 'heading': {
      const p = block.props as HeadingProps;
      return `    <mj-text font-size="${HEADING_SIZES[p.level] || '22px'}" color="${esc(p.color)}" font-family="Helvetica, Arial, sans-serif" align="${p.align}" font-weight="bold" padding="8px 24px">
      ${p.text}
    </mj-text>`;
    }

    case 'text': {
      const p = block.props as TextProps;
      return `    <mj-text font-size="15px" color="#334155" font-family="Helvetica, Arial, sans-serif" line-height="1.7" align="${p.align}" padding="4px 24px">
      ${p.html}
    </mj-text>`;
    }

    case 'image': {
      const p = block.props as ImageProps;
      const hrefAttr = p.href ? ` href="${esc(p.href)}"` : '';
      return `    <mj-image src="${esc(p.src)}" alt="${esc(p.alt)}" width="${p.width}"${hrefAttr} padding="8px 24px" />`;
    }

    case 'button': {
      const p = block.props as ButtonProps;
      return `    <mj-button background-color="${esc(p.bgColor)}" color="${esc(p.textColor)}" font-family="Helvetica, Arial, sans-serif" font-size="14px" border-radius="${p.borderRadius}" align="${p.align}" padding="12px 24px" inner-padding="12px 28px" href="${esc(p.url)}">
      ${p.label}
    </mj-button>`;
    }

    case 'divider': {
      const p = block.props as DividerProps;
      return `    <mj-divider border-color="${esc(p.color)}" border-width="${p.width}" padding="4px 24px" />`;
    }

    case 'spacer': {
      const p = block.props as SpacerProps;
      return `    <mj-spacer height="${p.height}" />`;
    }

    case 'social': {
      const p = block.props as SocialProps;
      const elements = p.networks
        .map((n) => `      <mj-social-element name="${esc(n.icon)}" href="${esc(n.url)}">${esc(n.name)}</mj-social-element>`)
        .join('\n');
      return `    <mj-social font-size="12px" icon-size="24px" mode="horizontal" align="${p.align}" padding="8px 24px">
${elements}
    </mj-social>`;
    }

    case 'footer': {
      const p = block.props as FooterProps;
      const unsub = p.showUnsubscribe
        ? '<br/><a href="{{unsubscribe_url}}" style="color:#64748b;">Unsubscribe</a>'
        : '';
      return `    <mj-text font-size="12px" color="#94a3b8" font-family="Helvetica, Arial, sans-serif" align="${p.align}" line-height="1.5" padding="16px 24px">
      ${p.text}${unsub}
    </mj-text>`;
    }

    case 'columns': {
      const p = block.props as ColumnsProps;
      const widths = getColumnWidths(p.layout, p.columns.length);
      const cols = p.columns
        .map((col, i) => {
          const inner = col.blocks.map(compileBlock).join('\n');
          return `    <mj-column width="${widths[i]}%">
${inner || '      <mj-text padding="8px 24px" color="#94a3b8" font-family="Helvetica, Arial, sans-serif" font-size="13px">&nbsp;</mj-text>'}
    </mj-column>`;
        })
        .join('\n');
      return `  </mj-column>
  </mj-section>
  <mj-section background-color="{{CONTENT_BG}}" padding="0">
${cols}
  </mj-section>
  <mj-section background-color="{{CONTENT_BG}}" padding="0">
  <mj-column>`;
    }

    default:
      return '';
  }
}

function getColumnWidths(layout: string, count: number): number[] {
  switch (layout) {
    case '50-50': return [50, 50];
    case '33-33-33': return [33, 33, 33];
    case '70-30': return [70, 30];
    case '30-70': return [30, 70];
    default: return Array(count).fill(Math.floor(100 / count));
  }
}

// --- Main compiler ---

export function compileToMjml(design: EmailDesign): string {
  const blocks = design.blocks.map(compileBlock).join('\n');

  const mjml = `<mjml>
  <mj-body background-color="${esc(design.bodyBackground)}" width="${design.contentWidth}px">
  <mj-section background-color="${esc(design.contentBackground)}" padding="0">
  <mj-column>
${blocks}
  </mj-column>
  </mj-section>
  </mj-body>
</mjml>`;

  // Replace the content background placeholder used by columns
  return mjml.replace(/\{\{CONTENT_BG\}\}/g, esc(design.contentBackground));
}

// --- Compliance validation ---

export interface ComplianceWarning {
  code: 'no_unsubscribe' | 'no_address' | 'no_footer';
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validate an email design for CAN-SPAM compliance.
 * Returns an array of warnings/errors.
 */
export function validateEmailCompliance(
  design: EmailDesign,
  businessAddress?: string,
): ComplianceWarning[] {
  const warnings: ComplianceWarning[] = [];

  // Check for footer block with unsubscribe
  const footerBlock = design.blocks.find((b) => b.type === 'footer');
  if (!footerBlock) {
    warnings.push({
      code: 'no_footer',
      message: 'No footer block found. CAN-SPAM requires an unsubscribe link and physical address in every commercial email.',
      severity: 'error',
    });
  } else {
    const props = footerBlock.props as FooterProps;
    if (!props.showUnsubscribe) {
      warnings.push({
        code: 'no_unsubscribe',
        message: 'Footer block has unsubscribe link disabled. CAN-SPAM requires a clear, 1-click unsubscribe link.',
        severity: 'error',
      });
    }
  }

  // Check for physical address
  if (!businessAddress || businessAddress.trim().length === 0) {
    warnings.push({
      code: 'no_address',
      message: 'No business address configured. Go to Settings → Compliance to add your physical mailing address.',
      severity: 'warning',
    });
  }

  return warnings;
}

/**
 * Inject the business physical address into footer blocks before compilation.
 * This mutates the design by appending the address to the footer text.
 */
export function injectPhysicalAddress(design: EmailDesign, address: string): EmailDesign {
  if (!address.trim()) return design;

  const updatedBlocks = design.blocks.map((block) => {
    if (block.type === 'footer') {
      const props = block.props as FooterProps;
      // Only inject if the address isn't already in the footer text
      if (!props.text.includes(address.trim())) {
        return {
          ...block,
          props: {
            ...props,
            text: `${props.text}<br/>${esc(address.trim())}`,
          },
        };
      }
    }
    return block;
  });

  return { ...design, blocks: updatedBlocks };
}

// --- Compile to HTML (client-side via mjml-browser) ---

export async function compileToHtml(design: EmailDesign, businessAddress?: string): Promise<string> {
  // Inject physical address if provided
  const processedDesign = businessAddress
    ? injectPhysicalAddress(design, businessAddress)
    : design;

  const mjmlString = compileToMjml(processedDesign);
  try {
    const mjml2html = (await import('mjml-browser')).default;
    const result = mjml2html(mjmlString, { minify: false });
    return result.html;
  } catch (err) {
    console.error('MJML compilation error:', err);
    // Return the raw MJML as fallback
    return `<!-- MJML compilation failed -->\n${mjmlString}`;
  }
}

