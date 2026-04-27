// ============================================
// Email Block Editor — Data Model & Templates
// ============================================

// --- Block Types ---

export type BlockType =
  | 'heading'
  | 'text'
  | 'image'
  | 'button'
  | 'divider'
  | 'columns'
  | 'spacer'
  | 'social'
  | 'footer'
  | 'table'
  | 'form-text-input'
  | 'form-textarea'
  | 'form-select'
  | 'form-checkbox'
  | 'form-radio'
  | 'form-submit';

export interface HeadingProps {
  text: string;
  level: 'h1' | 'h2' | 'h3';
  align: 'left' | 'center' | 'right';
  color: string;
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface TextProps {
  html: string;
  align: 'left' | 'center' | 'right';
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface ImageProps {
  src: string;
  alt: string;
  href: string;
  width: string;
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface ButtonProps {
  label: string;
  url: string;
  bgColor: string;
  textColor: string;
  borderRadius: string;
  align: 'left' | 'center' | 'right';
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface DividerProps {
  color: string;
  width: string;
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface ColumnsProps {
  layout: '50-50' | '33-33-33' | '70-30' | '30-70';
  columns: { blocks: EmailBlock[] }[];
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface SpacerProps {
  height: string;
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface SocialProps {
  align: 'left' | 'center' | 'right';
  networks: { name: string; url: string; icon: string }[];
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface FooterProps {
  text: string;
  showUnsubscribe: boolean;
  align: 'left' | 'center' | 'right';
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface TableProps {
  headers: string[];
  rows: string[][];
  headerBgColor: string;
  headerTextColor: string;
  borderColor: string;
  striped: boolean;
  align: 'left' | 'center' | 'right';
  blockBgColor?: string;
  blockBgImage?: string;
  blockPadding?: string;
}

export interface FormTextInputProps {
  label: string;
  placeholder: string;
  required: boolean;
  fieldName: string;
  inputType: 'text' | 'email' | 'tel' | 'url' | 'number';
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export interface FormTextareaProps {
  label: string;
  placeholder: string;
  required: boolean;
  fieldName: string;
  rows: number;
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export interface FormSelectProps {
  label: string;
  placeholder: string;
  required: boolean;
  fieldName: string;
  options: string[];
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export interface FormCheckboxProps {
  label: string;
  fieldName: string;
  checkedByDefault: boolean;
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export interface FormRadioProps {
  label: string;
  required: boolean;
  fieldName: string;
  options: string[];
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export interface FormSubmitProps {
  label: string;
  bgColor: string;
  textColor: string;
  borderRadius: string;
  align: 'left' | 'center' | 'right';
  successMessage: string;
  blockBgColor?: string;
  blockPadding?: string;
  blockBorderWidth?: string;
  blockBorderColor?: string;
  blockBorderRadius?: string;
}

export type BlockProps =
  | HeadingProps
  | TextProps
  | ImageProps
  | ButtonProps
  | DividerProps
  | ColumnsProps
  | SpacerProps
  | SocialProps
  | FooterProps
  | TableProps
  | FormTextInputProps
  | FormTextareaProps
  | FormSelectProps
  | FormCheckboxProps
  | FormRadioProps
  | FormSubmitProps;

export interface EmailBlock {
  id: string;
  type: BlockType;
  props: BlockProps;
}

// --- Email Design (the full document) ---

export interface EmailDesign {
  subject: string;
  previewText: string;
  bodyBackground: string;
  contentBackground: string;
  contentWidth: number;
  blocks: EmailBlock[];
}

// --- Helpers ---

let _blockCounter = 0;
export function createBlockId(): string {
  return `blk_${Date.now()}_${++_blockCounter}`;
}

export function createBlock(type: BlockType): EmailBlock {
  const id = createBlockId();
  switch (type) {
    case 'heading':
      return { id, type, props: { text: 'Your Heading', level: 'h1', align: 'center', color: '#1e293b' } as HeadingProps };
    case 'text':
      return { id, type, props: { html: '<p>Write your content here. Use <strong>bold</strong>, <em>italic</em>, and <a href="#">links</a>.</p>', align: 'left' } as TextProps };
    case 'image':
      return { id, type, props: { src: '', alt: 'Image description', href: '', width: '100%' } as ImageProps };
    case 'button':
      return { id, type, props: { label: 'Click Here', url: '#', bgColor: '#2563eb', textColor: '#ffffff', borderRadius: '6px', align: 'center' } as ButtonProps };
    case 'divider':
      return { id, type, props: { color: '#e2e8f0', width: '1px' } as DividerProps };
    case 'columns':
      return { id, type, props: { layout: '50-50', columns: [{ blocks: [] }, { blocks: [] }] } as ColumnsProps };
    case 'spacer':
      return { id, type, props: { height: '20px' } as SpacerProps };
    case 'social':
      return { id, type, props: { align: 'center', networks: [
        { name: 'Facebook', url: '#', icon: 'facebook' },
        { name: 'Twitter', url: '#', icon: 'twitter' },
        { name: 'Instagram', url: '#', icon: 'instagram' },
      ]} as SocialProps };
    case 'footer':
      return { id, type, props: { text: '© 2026 Your Company. All rights reserved.', showUnsubscribe: true, align: 'center' } as FooterProps };
    case 'table':
      return { id, type, props: {
        headers: ['Item', 'Details', 'Price'],
        rows: [
          ['Product A', 'Description here', '$29.99'],
          ['Product B', 'Description here', '$49.99'],
          ['Product C', 'Description here', '$19.99'],
        ],
        headerBgColor: '#1e293b',
        headerTextColor: '#ffffff',
        borderColor: '#e2e8f0',
        striped: true,
        align: 'left',
      } as TableProps };
    case 'form-text-input':
      return { id, type, props: {
        label: 'Name', placeholder: 'Enter your name', required: true,
        fieldName: 'name', inputType: 'text',
      } as FormTextInputProps };
    case 'form-textarea':
      return { id, type, props: {
        label: 'Message', placeholder: 'How can we help?', required: false,
        fieldName: 'message', rows: 4,
      } as FormTextareaProps };
    case 'form-select':
      return { id, type, props: {
        label: 'Select an option', placeholder: 'Choose...', required: true,
        fieldName: 'option', options: ['Option 1', 'Option 2', 'Option 3'],
      } as FormSelectProps };
    case 'form-checkbox':
      return { id, type, props: {
        label: 'I agree to the terms and conditions',
        fieldName: 'agree_terms', checkedByDefault: false,
      } as FormCheckboxProps };
    case 'form-radio':
      return { id, type, props: {
        label: 'Choose one', required: true,
        fieldName: 'choice', options: ['Option A', 'Option B', 'Option C'],
      } as FormRadioProps };
    case 'form-submit':
      return { id, type, props: {
        label: 'Submit', bgColor: '#059669', textColor: '#ffffff',
        borderRadius: '6px', align: 'center',
        successMessage: 'Thanks! We\'ll be in touch.',
      } as FormSubmitProps };
  }
}

// --- Block Palette Definition ---

export const BLOCK_PALETTE: { type: BlockType; label: string; icon: string; description: string }[] = [
  { type: 'heading', label: 'Heading', icon: 'H', description: 'Title or section header' },
  { type: 'text', label: 'Text', icon: '¶', description: 'Paragraph with formatting' },
  { type: 'image', label: 'Image', icon: '▣', description: 'Full-width or inline image' },
  { type: 'button', label: 'Button', icon: '◉', description: 'Call-to-action button' },
  { type: 'divider', label: 'Divider', icon: '—', description: 'Horizontal line separator' },
  { type: 'columns', label: 'Columns', icon: '▥', description: '2 or 3 column layout' },
  { type: 'spacer', label: 'Spacer', icon: '↕', description: 'Empty vertical space' },
  { type: 'social', label: 'Social', icon: '◈', description: 'Social media icon links' },
  { type: 'footer', label: 'Footer', icon: '▔', description: 'Footer with unsubscribe' },
  { type: 'table', label: 'Table', icon: '▦', description: 'Data table with rows & columns' },
];

// Email-only palette (alias)
export const EMAIL_PALETTE = BLOCK_PALETTE;

// Form palette — shared layout blocks + form-specific blocks
export const FORM_PALETTE: { type: BlockType; label: string; icon: string; description: string }[] = [
  { type: 'heading', label: 'Heading', icon: 'H', description: 'Title or section header' },
  { type: 'text', label: 'Text', icon: '¶', description: 'Description text' },
  { type: 'image', label: 'Image', icon: '▣', description: 'Logo or banner image' },
  { type: 'divider', label: 'Divider', icon: '—', description: 'Section separator' },
  { type: 'spacer', label: 'Spacer', icon: '↕', description: 'Vertical space' },
  { type: 'columns', label: 'Columns', icon: '▥', description: '2 or 3 column layout' },
  { type: 'form-text-input', label: 'Text Input', icon: '▭', description: 'Single-line text field' },
  { type: 'form-textarea', label: 'Textarea', icon: '▤', description: 'Multi-line text area' },
  { type: 'form-select', label: 'Dropdown', icon: '▾', description: 'Select from options' },
  { type: 'form-checkbox', label: 'Checkbox', icon: '☑', description: 'Single checkbox toggle' },
  { type: 'form-radio', label: 'Radio Group', icon: '◉', description: 'Choose one from options' },
  { type: 'form-submit', label: 'Submit', icon: '▶', description: 'Form submit button' },
];

// ============================================
// Saved Templates — User-created reusable designs
// ============================================

export interface SavedTemplate {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  design: EmailDesign;
}

const SAVED_TEMPLATES_KEY = 'clq-saved-templates';

export function loadSavedTemplates(): SavedTemplate[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(SAVED_TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveSavedTemplates(templates: SavedTemplate[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SAVED_TEMPLATES_KEY, JSON.stringify(templates));
}

export function addSavedTemplate(name: string, design: EmailDesign): SavedTemplate {
  const templates = loadSavedTemplates();
  const now = new Date().toISOString();
  const tmpl: SavedTemplate = {
    id: `tmpl_${Date.now()}`,
    name,
    createdAt: now,
    updatedAt: now,
    design: JSON.parse(JSON.stringify(design)),
  };
  templates.unshift(tmpl);
  saveSavedTemplates(templates);
  return tmpl;
}

export function updateSavedTemplate(id: string, patch: Partial<Pick<SavedTemplate, 'name' | 'design'>>): void {
  const templates = loadSavedTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const t = templates[idx]!;
  if (patch.name) t.name = patch.name;
  if (patch.design) t.design = JSON.parse(JSON.stringify(patch.design));
  t.updatedAt = new Date().toISOString();
  saveSavedTemplates(templates);
}

export function deleteSavedTemplate(id: string): void {
  const templates = loadSavedTemplates().filter((t) => t.id !== id);
  saveSavedTemplates(templates);
}

// ============================================
// Block Style Presets — Reusable block styles
// ============================================

export interface BlockPreset {
  id: string;
  name: string;
  type: BlockType;
  props: BlockProps;
  createdAt: string;
}

const BLOCK_PRESETS_KEY = 'clq-block-presets';

export function loadBlockPresets(): BlockPreset[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(BLOCK_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function saveBlockPresets(presets: BlockPreset[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(BLOCK_PRESETS_KEY, JSON.stringify(presets));
}

export function addBlockPreset(name: string, type: BlockType, props: BlockProps): BlockPreset {
  const presets = loadBlockPresets();
  const preset: BlockPreset = {
    id: `preset_${Date.now()}`,
    name,
    type,
    props: JSON.parse(JSON.stringify(props)),
    createdAt: new Date().toISOString(),
  };
  presets.unshift(preset);
  saveBlockPresets(presets);
  return preset;
}

export function deleteBlockPreset(id: string): void {
  const presets = loadBlockPresets().filter((p) => p.id !== id);
  saveBlockPresets(presets);
}

/** Create a block from a preset, generating a new ID */
export function createBlockFromPreset(preset: BlockPreset): EmailBlock {
  return {
    id: createBlockId(),
    type: preset.type,
    props: JSON.parse(JSON.stringify(preset.props)),
  };
}

// ============================================
// Starter Templates
// ============================================

export const STARTER_TEMPLATES: { id: string; name: string; emoji: string; description: string; design: EmailDesign }[] = [
  {
    id: 'newsletter',
    name: 'Newsletter',
    emoji: '▣',
    description: 'Weekly digest with header, content, and footer',
    design: {
      subject: 'This Week\'s Update',
      previewText: 'Here\'s what\'s new this week',
      bodyBackground: '#f0f2f5',
      contentBackground: '#ffffff',
      contentWidth: 600,
      blocks: [
        { id: 'n1', type: 'heading', props: { text: 'Your Brand', level: 'h1', align: 'center', color: '#1e293b' } },
        { id: 'n2', type: 'divider', props: { color: '#e2e8f0', width: '1px' } },
        { id: 'n3', type: 'heading', props: { text: 'This Week\'s Update', level: 'h2', align: 'center', color: '#1e293b' } },
        { id: 'n4', type: 'text', props: { html: '<p>Here\'s what\'s new and noteworthy this week. Click through to read more about each topic.</p>', align: 'left' } },
        { id: 'n5', type: 'divider', props: { color: '#e2e8f0', width: '1px' } },
        { id: 'n6', type: 'heading', props: { text: 'Feature Highlight', level: 'h3', align: 'left', color: '#1e293b' } },
        { id: 'n7', type: 'text', props: { html: '<p>Share your latest feature, article, or announcement here. Keep it concise and link to the full content for readers who want to learn more.</p>', align: 'left' } },
        { id: 'n8', type: 'button', props: { label: 'Read More', url: '#', bgColor: '#2563eb', textColor: '#ffffff', borderRadius: '6px', align: 'center' } },
        { id: 'n9', type: 'spacer', props: { height: '16px' } },
        { id: 'n10', type: 'footer', props: { text: '© 2026 Your Brand. All rights reserved.', showUnsubscribe: true, align: 'center' } },
      ],
    },
  },
  {
    id: 'promotion',
    name: 'Promotion',
    emoji: '◆',
    description: 'Sale or discount with bold CTA',
    design: {
      subject: '30% OFF — Limited Time Only',
      previewText: 'Use code SAVE30 at checkout',
      bodyBackground: '#f0f2f5',
      contentBackground: '#ffffff',
      contentWidth: 600,
      blocks: [
        { id: 'p1', type: 'spacer', props: { height: '16px' } },
        { id: 'p2', type: 'text', props: { html: '<p style="text-align:center; letter-spacing:2px; color:#7c3aed; font-size:12px;">LIMITED TIME OFFER</p>', align: 'center' } },
        { id: 'p3', type: 'heading', props: { text: '30% OFF', level: 'h1', align: 'center', color: '#7c3aed' } },
        { id: 'p4', type: 'text', props: { html: '<p style="text-align:center;">Use code <strong>SAVE30</strong> at checkout. Offer ends Sunday.</p>', align: 'center' } },
        { id: 'p5', type: 'button', props: { label: 'Shop Now', url: '#', bgColor: '#7c3aed', textColor: '#ffffff', borderRadius: '8px', align: 'center' } },
        { id: 'p6', type: 'divider', props: { color: '#e2e8f0', width: '1px' } },
        { id: 'p7', type: 'text', props: { html: '<p style="text-align:center;">✓ Free shipping on all orders<br/>✓ 30-day money-back guarantee<br/>✓ Premium quality materials</p>', align: 'center' } },
        { id: 'p8', type: 'spacer', props: { height: '8px' } },
        { id: 'p9', type: 'footer', props: { text: '© 2026 Your Store. All rights reserved.', showUnsubscribe: true, align: 'center' } },
      ],
    },
  },
  {
    id: 'welcome',
    name: 'Welcome',
    emoji: '○',
    description: 'Onboarding for new subscribers',
    design: {
      subject: 'Welcome aboard!',
      previewText: 'We\'re thrilled to have you',
      bodyBackground: '#f0f2f5',
      contentBackground: '#ffffff',
      contentWidth: 600,
      blocks: [
        { id: 'w1', type: 'heading', props: { text: 'Welcome!', level: 'h1', align: 'center', color: '#059669' } },
        { id: 'w2', type: 'text', props: { html: '<p style="text-align:center; color:#64748b;">We\'re thrilled to have you on board.</p>', align: 'center' } },
        { id: 'w3', type: 'divider', props: { color: '#e2e8f0', width: '1px' } },
        { id: 'w4', type: 'text', props: { html: '<p>Hi there,</p><p>Thanks for signing up! Here\'s what you can do next:</p><p><strong>1.</strong> Complete your profile<br/><strong>2.</strong> Explore our features<br/><strong>3.</strong> Connect with the community</p>', align: 'left' } },
        { id: 'w5', type: 'button', props: { label: 'Get Started', url: '#', bgColor: '#059669', textColor: '#ffffff', borderRadius: '6px', align: 'center' } },
        { id: 'w6', type: 'text', props: { html: '<p style="color:#64748b; font-size:14px;">Need help? Just reply to this email — we\'re here for you.</p>', align: 'left' } },
        { id: 'w7', type: 'footer', props: { text: '© 2026 Your Company', showUnsubscribe: true, align: 'center' } },
      ],
    },
  },
  {
    id: 'event',
    name: 'Event Invite',
    emoji: '□',
    description: 'Event with date, details, and RSVP',
    design: {
      subject: 'You\'re Invited: Annual Product Launch',
      previewText: 'June 15, 2026 · 2:00 PM EST',
      bodyBackground: '#f0f2f5',
      contentBackground: '#ffffff',
      contentWidth: 600,
      blocks: [
        { id: 'e1', type: 'text', props: { html: '<p style="text-align:center; letter-spacing:2px; color:#94a3b8; font-size:12px;">YOU\'RE INVITED</p>', align: 'center' } },
        { id: 'e2', type: 'heading', props: { text: 'Annual Product Launch', level: 'h1', align: 'center', color: '#1e293b' } },
        { id: 'e3', type: 'text', props: { html: '<p style="text-align:center; color:#2563eb; font-weight:600;">June 15, 2026 · 2:00 PM EST</p>', align: 'center' } },
        { id: 'e4', type: 'divider', props: { color: '#e2e8f0', width: '1px' } },
        { id: 'e5', type: 'text', props: { html: '<p>Join us for an exclusive look at what we\'ve been building. You\'ll get early access, live demos, and a chance to connect with our team.</p><p>📍 Virtual Event (Zoom link sent after RSVP)<br/>⏰ Duration: 90 minutes<br/>🎁 Exclusive swag for attendees</p>', align: 'left' } },
        { id: 'e6', type: 'button', props: { label: 'RSVP Now', url: '#', bgColor: '#2563eb', textColor: '#ffffff', borderRadius: '6px', align: 'center' } },
        { id: 'e7', type: 'footer', props: { text: '© 2026 Your Company', showUnsubscribe: true, align: 'center' } },
      ],
    },
  },
  {
    id: 'blank',
    name: 'Blank',
    emoji: '◇',
    description: 'Start from scratch',
    design: {
      subject: '',
      previewText: '',
      bodyBackground: '#f0f2f5',
      contentBackground: '#ffffff',
      contentWidth: 600,
      blocks: [
        { id: 'b1', type: 'heading', props: { text: 'Your Heading', level: 'h1', align: 'center', color: '#1e293b' } },
        { id: 'b2', type: 'text', props: { html: '<p>Start building your email. Add blocks from the sidebar.</p>', align: 'left' } },
        { id: 'b3', type: 'footer', props: { text: '© 2026 Your Company', showUnsubscribe: true, align: 'center' } },
      ],
    },
  },
];
