# Security Policy

## Reporting Security Vulnerabilities

If you discover a security vulnerability, please email christian@gsdat.work with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

Please do NOT open public issues for security vulnerabilities.

## Security Best Practices

### For Users

1. **Credentials**
   - Never commit `.env` files (it is git-ignored; `setup-mac.sh` writes it mode 600)
   - Your Unanet password is stored in plaintext in `.env` on your machine — treat that file like your password
   - Never share a service or integration account; each person uses their own Unanet login
   - Keep write tools disabled unless you need them and understand the risk

2. **Access Control**
   - Limit MCP server to localhost only
   - Use firewall rules if exposing remotely
   - Audit who has access to Claude Desktop with Unanet

3. **Data Protection**
   - Run in isolated environments
   - Don't log sensitive project data
   - Clear credentials from memory after use

### For Contributors

1. **Code Security**
   - Sanitize all inputs
   - Use parameterized queries
   - Implement rate limiting
   - Add input length limits

2. **Dependencies**
   - Keep dependencies updated
   - Run `npm audit` regularly
   - Review new dependencies carefully

3. **Error Handling**
   - Never expose system paths in errors
   - Mask sensitive data in logs
   - Use generic error messages for auth failures

## Known Security Considerations

1. **Credential Storage**: Currently uses environment variables (plaintext)
   - Future: Add support for encrypted credential stores

2. **API Rate Limiting**: Relies on Unanet's rate limiting
   - Future: Add client-side rate limiting

3. **Audit Logging**: Limited logging of operations
   - Future: Add comprehensive audit trail

## Security Checklist for Deployment

- [ ] All credentials in environment variables
- [ ] `.env` file has restricted permissions (600)
- [ ] No sensitive data in logs
- [ ] API user has minimum required permissions
- [ ] Regular security updates applied
- [ ] Monitoring configured for suspicious activity

## Compliance Notes

This tool processes data subject to:
- ITAR/EAR regulations (for defense contractors)
- FAR/DFARS requirements
- Company-specific data policies

Ensure your deployment complies with all applicable regulations.