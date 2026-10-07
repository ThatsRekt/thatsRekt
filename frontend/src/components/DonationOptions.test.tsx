import { describe, expect, it, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import { DonationOptions } from './DonationOptions'
import { DAO_FUND_INITIATIVE_URL } from '../lib/daoFund'

describe('DonationOptions', () => {
  afterEach(() => {
    cleanup()
  })

  it('asks for the DAO Fund campaign and keeps the legacy address', () => {
    render(<DonationOptions />)
    expect(screen.getByText(/selected for The DAO Fund/i)).toBeDefined()
    const link = screen.getByRole('link', { name: /please support/i })
    expect(link.getAttribute('href')).toBe(DAO_FUND_INITIATIVE_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('thatsrekt.eth')).toBeDefined()
    expect(screen.getByText(/legacy donation address/i)).toBeDefined()
    expect(screen.getByText(/direct sends to thatsrekt\.eth still work/i)).toBeDefined()
  })
})
