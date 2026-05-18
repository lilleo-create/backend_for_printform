"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeText = void 0;
const sanitize_html_1 = __importDefault(require("sanitize-html"));
const sanitizeText = (value) => (0, sanitize_html_1.default)(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard'
}).trim();
exports.sanitizeText = sanitizeText;
